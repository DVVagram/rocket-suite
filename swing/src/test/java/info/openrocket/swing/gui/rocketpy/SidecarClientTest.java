package info.openrocket.swing.gui.rocketpy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import jakarta.json.Json;
import jakarta.json.JsonObject;

/**
 * Exercises the Java side of the sidecar protocol against the real Python
 * process. Skipped when the repository's virtual environment or the sidecar
 * script is not present, so the suite stays runnable on a machine that has not
 * provisioned the Python stack yet.
 */
public class SidecarClientTest {

    private static Optional<Path> python() {
        return SidecarClient.findPython();
    }

    private static Path script() {
        return SidecarClient.findScript().orElseThrow();
    }

    private static void assumeProvisioned() {
        Assumptions.assumeTrue(python().isPresent(), "no Python interpreter (set ROCKETSUITE_PYTHON)");
        Assumptions.assumeTrue(SidecarClient.findScript().isPresent(), "sidecar script not found");
    }

    @Test
    public void healthRoundTripsOverTheProtocol() throws Exception {
        assumeProvisioned();
        List<String> log = Collections.synchronizedList(new ArrayList<>());
        try (SidecarClient client = new SidecarClient(python().get(), script(), log::add)) {
            client.start();
            JsonObject health = client.health();
            assertEquals("rocketpy", health.getString("engine"));
            assertEquals(1, health.getInt("protocol"));
            assertTrue(health.getString("rocketpy").startsWith("1."),
                    "unexpected RocketPy version: " + health.getString("rocketpy"));
            assertTrue(client.readyFrame() != null, "the sidecar must announce itself");
        }
    }

    @Test
    public void unknownMethodSurfacesAsSidecarError() throws Exception {
        assumeProvisioned();
        try (SidecarClient client = new SidecarClient(python().get(), script(), line -> { })) {
            client.start();
            SidecarClient.SidecarException error = assertThrows(SidecarClient.SidecarException.class,
                    () -> client.request("nope", Json.createObjectBuilder().build(), Duration.ofSeconds(20)));
            assertEquals("UnknownMethod", error.getType());
            // The process must survive its own error path.
            assertEquals("rocketpy", client.health().getString("engine"));
        }
    }

    @Test
    public void missingInterpreterFailsLoudly() {
        Path bogus = Path.of("definitely-not-a-python");
        Assumptions.assumeTrue(SidecarClient.findScript().isPresent(), "sidecar script not found");
        assertThrows(java.io.IOException.class,
                () -> new SidecarClient(bogus, SidecarClient.findScript().orElseThrow(), line -> { }).start());
    }

    @Test
    public void sidecarDeathIsReportedInsteadOfHanging() throws Exception {
        assumeProvisioned();
        try (SidecarClient client = new SidecarClient(python().get(), script(), line -> { })) {
            client.start();
            client.health();

            client.processForTesting().destroyForcibly();
            for (int i = 0; i < 50 && client.isRunning(); i++) {
                Thread.sleep(100);
            }
            assertTrue(!client.isRunning(), "a dead sidecar must not still report as running");

            SidecarClient.SidecarException error = assertThrows(SidecarClient.SidecarException.class,
                    client::health);
            assertEquals("SidecarUnavailable", error.getType());
        }
    }

    @Test
    public void timedOutRequestStopsTheSidecarProcess() throws Exception {
        Path python = python().orElseThrow();
        Path script = Files.createTempFile("rocketsuite-timeout-sidecar-", ".py");
        Files.writeString(script, "import json, sys, time\n"
                + "print(json.dumps({'event':'ready'}), flush=True)\n"
                + "sys.stdin.readline()\n"
                + "time.sleep(300)\n");
        try (SidecarClient client = new SidecarClient(python, script, line -> { })) {
            client.start();
            SidecarClient.SidecarException error = assertThrows(SidecarClient.SidecarException.class,
                    () -> client.request("hang", Json.createObjectBuilder().build(), Duration.ofMillis(300)));
            assertEquals("Timeout", error.getType());
            for (int i = 0; i < 50 && client.processForTesting().isAlive(); i++) {
                Thread.sleep(100);
            }
            assertTrue(!client.isRunning(), "a timed-out sidecar must be stopped to release memory");
            SidecarClient.SidecarException unavailable = assertThrows(SidecarClient.SidecarException.class,
                    client::health);
            assertEquals("SidecarUnavailable", unavailable.getType());
        } finally {
            Files.deleteIfExists(script);
        }
    }

    @Test
    public void locatedScriptExists() {
        assumeProvisioned();
        assertTrue(Files.isRegularFile(script()), "resolved sidecar script must exist: " + script());
    }
}
