package info.openrocket.swing.gui.rocketpy;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import jakarta.json.Json;
import jakarta.json.JsonObject;

/**
 * Client for the RocketPy sidecar process.
 * <p>
 * The sidecar speaks newline-delimited JSON over stdin/stdout (see
 * {@code sidecar/README.md}). Requests are matched to responses by an id chosen
 * here, so a slow flight never blocks the caller's thread beyond its own
 * timeout, and anything the sidecar writes on stderr is forwarded to the log
 * instead of being mistaken for a frame.
 * <p>
 * The client owns the process: {@link #close()} terminates it, and the sidecar
 * is started explicitly rather than with the application, so opening OpenRocket
 * costs nothing when RocketPy is not used.
 */
public class SidecarClient implements AutoCloseable {

    /** Generous default: S4 flights take seconds, but a cold import can be slower. */
    public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(60);

    private final Path python;
    private final Path script;
    private final Consumer<String> log;
    private final AtomicLong ids = new AtomicLong();
    private final Map<String, ArrayBlockingQueue<JsonObject>> pending = new ConcurrentHashMap<>();

    private Process process;
    private BufferedWriter toSidecar;
    private volatile JsonObject ready;
    private volatile String deadReason;

    public SidecarClient(Path python, Path script, Consumer<String> log) {
        this.python = python;
        this.script = script;
        this.log = log;
    }

    /** Raised for transport failures and for sidecar-reported errors. */
    public static class SidecarException extends Exception {
        private static final long serialVersionUID = 1L;
        private final String type;

        public SidecarException(String type, String message) {
            super(message);
            this.type = type;
        }

        public String getType() {
            return type;
        }
    }

    // ----- process lifecycle -------------------------------------------------

    public void start() throws IOException {
        if (process != null && process.isAlive()) {
            return;
        }
        if (!Files.isRegularFile(script)) {
            throw new IOException("Sidecar script not found: " + script);
        }
        ProcessBuilder builder = new ProcessBuilder(python.toString(), script.toString());
        builder.redirectErrorStream(false);
        process = builder.start();
        toSidecar = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        deadReason = null;

        startDaemon("rocketpy-sidecar-out", this::readFrames);
        startDaemon("rocketpy-sidecar-err", this::drainErrors);
        log.accept("sidecar started: " + python.getFileName() + " " + script.getFileName());
    }

    private void startDaemon(String name, Runnable body) {
        Thread thread = new Thread(body, name);
        thread.setDaemon(true);
        thread.start();
    }

    private void readFrames() {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.strip();
                if (line.isEmpty()) {
                    continue;
                }
                JsonObject frame;
                try {
                    frame = Json.createReader(new StringReader(line)).readObject();
                } catch (RuntimeException malformed) {
                    log.accept("sidecar sent an unparseable frame: " + line);
                    continue;
                }
                dispatch(frame);
            }
        } catch (IOException e) {
            log.accept("sidecar stream closed: " + e.getMessage());
        } finally {
            if (deadReason == null) {
                int exit = process != null && !process.isAlive() ? process.exitValue() : -1;
                deadReason = "sidecar stopped (exit code " + exit + ")";
                log.accept(deadReason);
                failPending(deadReason);
            }
        }
    }

    private void dispatch(JsonObject frame) {
        if (frame.containsKey("event")) {
            ready = frame;
            log.accept("sidecar ready: engine=" + frame.getString("engine", "?")
                    + " rocketpy=" + frame.getString("rocketpy", "?")
                    + " python=" + frame.getString("python", "?"));
            return;
        }
        String id = frame.getString("id", null);
        ArrayBlockingQueue<JsonObject> slot = id == null ? null : pending.get(id);
        if (slot == null) {
            log.accept("sidecar answered an unknown request id: " + id);
            return;
        }
        slot.offer(frame);
    }

    private void drainErrors() {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                log.accept("[stderr] " + line);
            }
        } catch (IOException ignored) {
            // the process is gone; readFrames reports the exit
        }
    }

    private void failPending(String reason) {
        JsonObject failure = Json.createObjectBuilder()
                .add("ok", false)
                .add("error", Json.createObjectBuilder()
                        .add("type", "SidecarUnavailable")
                        .add("message", reason))
                .build();
        pending.values().forEach(slot -> slot.offer(failure));
    }

    // ----- requests ----------------------------------------------------------

    public JsonObject readyFrame() {
        return ready;
    }

    /** Package-private so tests can simulate a crash and check the reporting. */
    Process processForTesting() {
        return process;
    }

    public boolean isRunning() {
        return process != null && process.isAlive() && deadReason == null;
    }

    public JsonObject request(String method, JsonObject params, Duration timeout)
            throws SidecarException {
        if (process == null) {
            throw new SidecarException("SidecarUnavailable", "the sidecar has not been started");
        }
        if (!isRunning()) {
            throw new SidecarException("SidecarUnavailable",
                    deadReason == null ? "the sidecar is not running" : deadReason);
        }

        String id = "r" + ids.incrementAndGet();
        ArrayBlockingQueue<JsonObject> slot = new ArrayBlockingQueue<>(1);
        pending.put(id, slot);
        try {
            JsonObject payload = params == null ? Json.createObjectBuilder().build() : params;
            JsonObject request = Json.createObjectBuilder()
                    .add("id", id)
                    .add("method", method)
                    .add("params", payload)
                    .build();
            write(request.toString());

            JsonObject response;
            try {
                response = slot.poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new SidecarException("Interrupted", "interrupted while waiting for the sidecar");
            }
            if (response == null) {
                String reason = "the sidecar did not answer '" + method + "' within "
                        + timeout.toSeconds() + " s; the sidecar was stopped";
                deadReason = reason;
                failPending(reason);
                Process timedOut = process;
                if (timedOut != null && timedOut.isAlive()) {
                    timedOut.destroyForcibly();
                }
                throw new SidecarException("Timeout", reason);
            }
            if (!response.getBoolean("ok", false)) {
                JsonObject error = response.getJsonObject("error");
                throw new SidecarException(
                        error == null ? "SidecarError" : error.getString("type", "SidecarError"),
                        error == null ? "the sidecar reported an error" : error.getString("message", ""));
            }
            return response.getJsonObject("result");
        } finally {
            pending.remove(id);
        }
    }

    public JsonObject request(String method) throws SidecarException {
        return request(method, null, DEFAULT_TIMEOUT);
    }

    public JsonObject health() throws SidecarException {
        return request("health");
    }

    private void write(String line) throws SidecarException {
        try {
            toSidecar.write(line);
            toSidecar.write('\n');
            toSidecar.flush();
        } catch (IOException e) {
            throw new SidecarException("TransportFailure", "could not write to the sidecar: " + e.getMessage());
        }
    }

    @Override
    public void close() {
        if (process != null) {
            deadReason = "closed";
            failPending(deadReason);
            process.destroy();
            try {
                if (!process.waitFor(3, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            } finally {
                log.accept("sidecar stopped");
            }
        }
    }

    // ----- discovery ---------------------------------------------------------

    /**
     * Locate a Python interpreter: {@code ROCKETSUITE_PYTHON} first, then the
     * repository's virtual environment, walking up from the working directory
     * because Gradle runs tests inside a module directory while the application
     * runs from the repository root.
     */
    public static Optional<Path> findPython() {
        String explicit = System.getenv("ROCKETSUITE_PYTHON");
        if (explicit != null && !explicit.isBlank()) {
            Path path = Path.of(explicit);
            return Files.isRegularFile(path) ? Optional.of(path) : Optional.empty();
        }
        for (Path base : searchRoots()) {
            for (String relative : new String[] { ".venv/Scripts/python.exe", ".venv/bin/python" }) {
                Path candidate = base.resolve(relative);
                if (Files.isRegularFile(candidate)) {
                    return Optional.of(candidate);
                }
            }
        }
        return Optional.empty();
    }

    /** Locate {@code sidecar/rocketpy_sidecar.py} relative to the working directory. */
    public static Optional<Path> findScript() {
        String explicit = System.getenv("ROCKETSUITE_SIDECAR");
        if (explicit != null && !explicit.isBlank()) {
            Path path = Path.of(explicit);
            return Files.isRegularFile(path) ? Optional.of(path) : Optional.empty();
        }
        for (Path base : searchRoots()) {
            Path candidate = base.resolve("sidecar").resolve("rocketpy_sidecar.py");
            if (Files.isRegularFile(candidate)) {
                return Optional.of(candidate);
            }
        }
        return Optional.empty();
    }

    private static Iterable<Path> searchRoots() {
        java.util.List<Path> roots = new java.util.ArrayList<>();
        Path current = Path.of(System.getProperty("user.dir", ".")).toAbsolutePath();
        for (int depth = 0; depth < 4 && current != null; depth++) {
            roots.add(current);
            current = current.getParent();
        }
        return roots;
    }
}
