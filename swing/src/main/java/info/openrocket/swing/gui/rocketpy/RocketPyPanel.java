package info.openrocket.swing.gui.rocketpy;

import java.awt.BorderLayout;
import java.awt.FlowLayout;
import java.awt.Font;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.ExecutionException;

import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;
import javax.swing.SwingWorker;

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
    private final JLabel statusLabel = new JLabel("Not connected");
    private final JButton connectButton = new JButton("Connect to RocketPy");
    private final JTextArea logArea = new JTextArea();

    private SidecarClient client;

    public RocketPyPanel(OpenRocketDocument document) {
        super(new BorderLayout(0, 8));
        this.document = document;

        setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));

        JLabel title = new JLabel("RocketPy flight");
        title.setFont(title.getFont().deriveFont(Font.BOLD, title.getFont().getSize2D() + 3f));

        JPanel statusBar = new JPanel(new BorderLayout());
        statusBar.add(statusLabel, BorderLayout.WEST);
        JPanel buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT, 0, 0));
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

        add(header, BorderLayout.NORTH);
        add(new JScrollPane(logArea), BorderLayout.CENTER);
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
        setStatus("Not connected");
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
