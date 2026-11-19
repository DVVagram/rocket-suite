package info.openrocket.swing.gui.rocketpy;

import java.awt.BorderLayout;
import java.awt.FlowLayout;
import java.awt.Font;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutionException;

import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;
import javax.swing.SwingWorker;

import jakarta.json.Json;
import jakarta.json.JsonArray;
import jakarta.json.JsonObjectBuilder;
import jakarta.json.JsonNumber;
import jakarta.json.JsonObject;

import info.openrocket.core.document.OpenRocketDocument;

/**
 * Panel for the "RocketPy" tab.
 * <p>
 * The tab is a sibling of OpenRocket's own "Rocket design", "Motors &amp;
 * Configuration" and "Flight simulations" tabs: OpenRocket remains the host
 * application and stays responsible for the design, while this panel drives the
 * Python sidecar that runs RocketPy.
 * <p>
 * The panel deliberately contains no engineering logic. Every number shown here
 * must come from RocketPy, and nothing here may read or write design values.
 */
public class RocketPyPanel extends JPanel {

    private static final long serialVersionUID = 1L;

    /** A started sidecar together with its health report. */
    private record Connection(SidecarClient client, JsonObject health) {
    }

    private final OpenRocketDocument document;
    /** Conversion is slower than a health check: it starts a JVM and loads the motor database. */
    private static final Duration CONVERT_TIMEOUT = Duration.ofSeconds(180);

    private final JLabel statusLabel = new JLabel("Not connected");
    private final JButton connectButton = new JButton("Connect to RocketPy");
    private final JButton convertButton = new JButton("Convert design");
    private final JButton flyButton = new JButton("Fly");
    private final JTextArea logArea = new JTextArea();
    private final RocketPyResultsPanel resultsPanel = new RocketPyResultsPanel(this::appendLog);

    private record FlightRun(JsonObject flight, JsonObject plots) {
    }

    private SidecarClient client;
    private JsonObject lastConversion;
    private JsonObject lastFlight;
    private JsonObject previousFlight;
    private String lastConfigurationName;

    public RocketPyPanel(OpenRocketDocument document) {
        super(new BorderLayout(0, 8));
        this.document = document;

        setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));

        JLabel title = new JLabel("RocketPy flight");
        title.setFont(title.getFont().deriveFont(Font.BOLD, title.getFont().getSize2D() + 3f));

        JPanel statusBar = new JPanel(new BorderLayout());
        statusBar.add(statusLabel, BorderLayout.WEST);
        JPanel buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT, 6, 0));
        convertButton.setEnabled(false);
        convertButton.setToolTipText("Send the design as it currently stands to RocketPy, without saving it");
        flyButton.setEnabled(false);
        flyButton.setToolTipText("Fly the converted design in RocketPy");
        buttons.add(convertButton);
        buttons.add(flyButton);
        buttons.add(connectButton);
        statusBar.add(buttons, BorderLayout.EAST);

        JPanel header = new JPanel(new BorderLayout(0, 6));
        header.add(title, BorderLayout.NORTH);
        header.add(statusBar, BorderLayout.SOUTH);

        logArea.setEditable(false);
        logArea.setLineWrap(true);
        logArea.setWrapStyleWord(true);
        logArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        logArea.setText("""
                The design is taken from the open OpenRocket document and flown by RocketPy.

                OpenRocket owns the design: geometry, mass, centre of gravity, inertia, \
                centre of pressure, stability, thrust and drag curves.
                RocketPy owns the flight: atmosphere, gravity, forces, trajectory, events and apogee.

                Only design inputs cross between them, one way. OpenRocket's own simulation \
                results are shown for comparison and are never read by RocketPy.

                Press "Connect to RocketPy" to start the flight engine in its own process.""");

        connectButton.addActionListener(e -> toggleConnection());
        convertButton.addActionListener(e -> convertDesign());
        flyButton.addActionListener(e -> flyDesign());

        javax.swing.JSplitPane split = new javax.swing.JSplitPane(
                javax.swing.JSplitPane.VERTICAL_SPLIT, new JScrollPane(logArea), resultsPanel);
        split.setResizeWeight(0.62);
        split.setBorder(null);

        add(header, BorderLayout.NORTH);
        add(split, BorderLayout.CENTER);
    }

    /** The plots and console area, exposed for tests. */
    public RocketPyResultsPanel getResultsPanel() {
        return resultsPanel;
    }

    public OpenRocketDocument getDocument() {
        return document;
    }

    /** True while a sidecar process is running for this panel. */
    public boolean isConnected() {
        return client != null && client.isRunning();
    }

    /** Connect on demand: the sidecar is never started by opening the application. */
    private void toggleConnection() {
        if (client != null) {
            disconnect();
            return;
        }

        connectButton.setEnabled(false);
        setStatus("Starting the RocketPy sidecar…");

        new SwingWorker<Connection, String>() {
            @Override
            protected Connection doInBackground() throws Exception {
                Path python = SidecarClient.findPython().orElseThrow(() -> new IllegalStateException(
                        "No Python interpreter found. Set ROCKETSUITE_PYTHON or create the .venv (see PLAN.md)."));
                Path script = SidecarClient.findScript().orElseThrow(() -> new IllegalStateException(
                        "sidecar/rocketpy_sidecar.py not found. Set ROCKETSUITE_SIDECAR."));
                SidecarClient created = new SidecarClient(python, script, this::publish);
                created.start();
                return new Connection(created, created.health());
            }

            @Override
            protected void process(List<String> chunks) {
                chunks.forEach(RocketPyPanel.this::appendLog);
            }

            @Override
            protected void done() {
                connectButton.setEnabled(true);
                try {
                    Connection connection = get();
                    client = connection.client();
                    JsonObject health = connection.health();
                    setStatus("Connected · RocketPy " + health.getString("rocketpy", "?")
                            + " · Python " + health.getString("python", "?"));
                    connectButton.setText("Disconnect");
                    convertButton.setEnabled(true);
                    flyButton.setEnabled(lastConversion != null);
                    resultsPanel.setClient(client);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    setStatus("Not connected");
                } catch (ExecutionException e) {
                    client = null;
                    setStatus("Not connected");
                    appendLog("Could not start the RocketPy sidecar: " + rootCause(e.getCause()));
                }
            }
        }.execute();
    }

    private void disconnect() {
        if (client != null) {
            client.close();
            client = null;
        }
        connectButton.setText("Connect to RocketPy");
        convertButton.setEnabled(false);
        flyButton.setEnabled(false);
        resultsPanel.setClient(null);
        setStatus("Not connected");
    }

    /** The last RocketPy flight result, or null if the design has not been flown. */
    public JsonObject getLastFlight() {
        return lastFlight;
    }

    /** Fly the converted parameters. Nothing is re-read from the design here. */
    public void flyDesign() {
        SidecarClient active = client;
        JsonObject conversion = lastConversion;
        if (active == null || !active.isRunning() || conversion == null) {
            appendLog("Convert the design before flying it.");
            return;
        }

        flyButton.setEnabled(false);
        setStatus("Flying…");

        new SwingWorker<FlightRun, String>() {
            @Override
            protected FlightRun doInBackground() throws Exception {
                JsonObject params = Json.createObjectBuilder()
                        .add("parameters", conversion.getJsonObject("parameters"))
                        .build();
                JsonObject flown = active.request("fly", params, CONVERT_TIMEOUT);

                JsonObject figures = null;
                try {
                    figures = active.request("plot", Json.createObjectBuilder().build(), CONVERT_TIMEOUT);
                } catch (SidecarClient.SidecarException e) {
                    publish("RocketPy's plots are unavailable: " + e.getMessage());
                }
                return new FlightRun(flown, figures);
            }

            @Override
            protected void process(List<String> chunks) {
                chunks.forEach(RocketPyPanel.this::appendLog);
            }

            @Override
            protected void done() {
                flyButton.setEnabled(isConnected() && lastConversion != null);
                try {
                    FlightRun run = get();
                    lastFlight = run.flight();
                    resultsPanel.showPlots(run.plots());
                    showFlight(lastFlight);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    setStatus("Flight interrupted");
                } catch (ExecutionException e) {
                    setStatus("Flight failed");
                    appendLog("RocketPy could not fly this design: " + rootCause(e.getCause()));
                }
            }
        }.execute();
    }

    private void showFlight(JsonObject result) {
        JsonObject flight = result.getJsonObject("flight");
        JsonObject report = result.getJsonObject("report");

        StringBuilder text = new StringBuilder("\n\n=== RocketPy flight ===\n");
        if (flight != null) {
            appendNumber(text, "apogee", flight, "apogee_m", "m", 1);
            appendNumber(text, "apogee time", flight, "apogee_time_s", "s", 2);
            appendNumber(text, "max speed", flight, "max_speed_m_s", "m/s", 1);
            appendNumber(text, "max Mach", flight, "max_mach", "", 3);
            appendNumber(text, "max acceleration", flight, "max_acceleration_m_s2", "m/s²", 1);
            appendNumber(text, "off the rail", flight, "out_of_rail_velocity_m_s", "m/s", 1);
            appendNumber(text, "flight time", flight, "flight_time_s", "s", 2);
            appendNumber(text, "static margin", flight, "static_margin_calibers", "cal", 2);
        }
        for (int i = 0; result.getJsonArray("events") != null && i < result.getJsonArray("events").size(); i++) {
            JsonObject event = result.getJsonArray("events").getJsonObject(i);
            text.append("\n  ").append(event.getString("name", "event"));
            if (event.containsKey("time_s") && !event.isNull("time_s")) {
                text.append(String.format(Locale.ROOT, " at %.2f s", event.getJsonNumber("time_s").doubleValue()));
            }
            if (event.containsKey("altitude_m") && !event.isNull("altitude_m")) {
                text.append(String.format(Locale.ROOT, ", %.1f m", event.getJsonNumber("altitude_m").doubleValue()));
            }
        }
        if (report != null) {
            appendList(text, "Modelling approximations", report.getJsonArray("approximations"));
            appendList(text, "Not modelled", report.getJsonArray("unsupported"));
        }
        appendComparison(text, flight);
        appendReference(text, flight == null ? null : flight.getJsonNumber("apogee_m").doubleValue());
        appendLog(text.toString());

        previousFlight = flight;

        setStatus(flight == null ? "Flown" : String.format(Locale.ROOT,
                "Flown · apogee %.1f m", flight.getJsonNumber("apogee_m").doubleValue()));
    }

    /** RocketPy against its own previous run, so a changed design is visible. */
    private void appendComparison(StringBuilder text, JsonObject flight) {
        if (previousFlight == null || flight == null) {
            return;
        }
        text.append("\n\nCompared with the previous RocketPy run in this session:");
        appendChange(text, "apogee", previousFlight, flight, "apogee_m", "m", 1);
        appendChange(text, "max speed", previousFlight, flight, "max_speed_m_s", "m/s", 1);
        appendChange(text, "flight time", previousFlight, flight, "flight_time_s", "s", 2);
    }

    private static void appendChange(StringBuilder text, String label, JsonObject before,
            JsonObject after, String key, String unit, int decimals) {
        if (!before.containsKey(key) || !after.containsKey(key)) {
            return;
        }
        double previous = before.getJsonNumber(key).doubleValue();
        double current = after.getJsonNumber(key).doubleValue();
        String direction = current > previous ? "higher" : current < previous ? "lower" : "unchanged";
        if (previous == 0) {
            text.append("\n  ").append(label).append(": ")
                    .append(String.format(Locale.ROOT, "%." + decimals + "f %s", current, unit));
            return;
        }
        text.append("\n  ").append(label).append(": ")
                .append(String.format(Locale.ROOT, "%." + decimals + "f %s", current, unit))
                .append(String.format(Locale.ROOT, " (%s, %+.1f %%)", direction,
                        (current - previous) / previous * 100));
    }

    /**
     * OpenRocket's stored flight, shown beside RocketPy's and labelled as such.
     * It is never sent to the flight engine: it is here so a difference is
     * visible instead of hidden.
     */
    private void appendReference(StringBuilder text, Double rocketPyApogee) {
        JsonObject reference = lastConversion == null ? null : lastConversion.getJsonObject("reference");
        if (reference == null || reference.isEmpty()) {
            return;
        }
        text.append("\n\nOpenRocket's own stored flight - reference only, not used by RocketPy:");
        appendNumber(text, "apogee", reference, "max_altitude", "m", 1);
        appendNumber(text, "max speed", reference, "max_velocity", "m/s", 1);
        appendNumber(text, "flight time", reference, "flight_time", "s", 2);
        if (rocketPyApogee != null && reference.containsKey("max_altitude")
                && !reference.isNull("max_altitude")) {
            double stored = reference.getJsonNumber("max_altitude").doubleValue();
            if (stored > 0) {
                text.append(String.format(Locale.ROOT, "\n  apogee difference: %+.1f %%",
                        (rocketPyApogee - stored) / stored * 100));
            }
        }
        text.append("\n  Both numbers describe the same configuration, so a difference is a "
                + "modelling difference between the two engines, not a mismatch of designs.");
    }

    private static void appendNumber(StringBuilder text, String label, JsonObject values,
            String key, String unit, int decimals) {
        if (!values.containsKey(key) || values.isNull(key)) {
            return;
        }
        text.append("\n  ").append(label).append(": ")
                .append(String.format(Locale.ROOT, "%." + decimals + "f", values.getJsonNumber(key).doubleValue()));
        if (!unit.isEmpty()) {
            text.append(' ').append(unit);
        }
    }

    /** The last successful conversion, or null if the design has not been converted yet. */
    public JsonObject getLastConversion() {
        return lastConversion;
    }

    /**
     * Export the live design and have RocketPy's side convert it.
     * <p>
     * The design is written to a temporary file and handed over whole: no design
     * value is computed here, and nothing is written into the user's document.
     */
    public void convertDesign() {
        SidecarClient active = client;
        if (active == null || !active.isRunning()) {
            appendLog("Connect to RocketPy before converting the design.");
            return;
        }

        convertButton.setEnabled(false);
        setStatus("Converting the design…");

        new SwingWorker<JsonObject, String>() {
            private Path staged;

            @Override
            protected JsonObject doInBackground() throws Exception {
                staged = DocumentExport.saveToTemp(document);
                lastConfigurationName = DocumentExport.selectedConfigurationName(document);
                publish("design saved for conversion: " + staged.getFileName());
                publish("configuration: " + lastConfigurationName);
                JsonObjectBuilder params = Json.createObjectBuilder()
                        .add("ork", staged.toString())
                        .add("java_home", System.getProperty("java.home"));
                String configuration = DocumentExport.selectedConfigurationId(document);
                if (configuration != null) {
                    params.add("configuration", configuration);
                }
                return active.request("convert", params.build(), CONVERT_TIMEOUT);
            }

            @Override
            protected void process(List<String> chunks) {
                chunks.forEach(RocketPyPanel.this::appendLog);
            }

            @Override
            protected void done() {
                convertButton.setEnabled(isConnected());
                try {
                    lastConversion = get();
                    flyButton.setEnabled(true);
                    showConversion(lastConversion);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    setStatus("Conversion interrupted");
                } catch (ExecutionException e) {
                    setStatus("Conversion failed");
                    appendLog("Could not convert the design: " + rootCause(e.getCause()));
                } finally {
                    if (staged != null) {
                        try {
                            Files.deleteIfExists(staged);
                        } catch (IOException ignored) {
                            // a stray temp file is harmless
                        }
                    }
                }
            }
        }.execute();
    }

    private void showConversion(JsonObject result) {
        JsonObject design = result.getJsonObject("design");
        JsonObject report = result.getJsonObject("report");

        StringBuilder text = new StringBuilder("\n\n=== Converted design ===\n");
        text.append(design == null ? "unnamed" : design.getString("name", "unnamed"));
        if (design != null) {
            appendMeasurement(text, "mass", design, "mass_kg", 1000.0, "g", 1);
            appendMeasurement(text, "body radius", design, "radius_m", 1000.0, "mm", 1);
            appendMeasurement(text, "centre of mass", design, "centre_of_mass_m", 1000.0, "mm", 1);
            text.append("\n").append(design.getInt("fin_sets", 0)).append(" fin set(s), ")
                    .append(design.getInt("parachutes", 0)).append(" parachute(s)");
        }
        if (report != null) {
            text.append("\nConverted by ").append(report.getString("converter", "unknown"))
                    .append("; OpenRocket's own results are kept aside for comparison only.");
            JsonObject configuration = report.getJsonObject("configuration");
            if (configuration != null) {
                text.append("\nOnly configuration '").append(lastConfigurationName == null ? "?" : lastConfigurationName)
                        .append("' was converted: ").append(configuration.getInt("remaining_simulations", 1))
                        .append(" of its simulations kept, ")
                        .append(configuration.getInt("removed_simulations", 0)).append(" others set aside.");
            }
            JsonObject flightData = report.getJsonObject("flight_data");
            if (flightData != null) {
                text.append("\nStored flight taken from: ").append(flightData.getString("simulation", "unknown"));
            }
            appendList(text, "Warnings", report.getJsonArray("warnings"));
            appendList(text, "Not representable", report.getJsonArray("unsupported"));
            appendList(text, "Approximations", report.getJsonArray("approximations"));
        }
        appendLog(text.toString());

        String name = design == null ? "the design" : design.getString("name", "the design");
        setStatus("Converted " + name);
    }

    private static void appendMeasurement(StringBuilder text, String label, JsonObject design,
            String key, double scale, String unit, int decimals) {
        if (!design.containsKey(key) || design.get(key).getValueType() != jakarta.json.JsonValue.ValueType.NUMBER) {
            return;
        }
        JsonNumber value = design.getJsonNumber(key);
        text.append("\n  ").append(label).append(": ")
                .append(String.format(Locale.ROOT, "%." + decimals + "f %s", value.doubleValue() * scale, unit));
    }

    private static void appendList(StringBuilder text, String label, JsonArray items) {
        if (items == null || items.isEmpty()) {
            return;
        }
        text.append("\n").append(label).append(" (").append(items.size()).append("):");
        for (int i = 0; i < items.size(); i++) {
            text.append("\n  - ").append(items.getString(i));
        }
    }

    private static String rootCause(Throwable throwable) {
        Throwable cause = throwable;
        while (cause != null && cause.getCause() != null && cause.getCause() != cause) {
            cause = cause.getCause();
        }
        if (cause == null) {
            return "unknown error";
        }
        String message = cause.getMessage();
        return cause.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }

    /** Short state line shown under the title. */
    public void setStatus(String status) {
        statusLabel.setText(status);
    }

    /** Append a line to the panel log. */
    public void appendLog(String line) {
        logArea.append("\n" + line);
        logArea.setCaretPosition(logArea.getDocument().getLength());
    }

    public void clearLog() {
        logArea.setText("");
    }
}
