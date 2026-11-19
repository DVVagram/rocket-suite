package info.openrocket.swing.gui.rocketpy;

import java.awt.BorderLayout;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.Image;
import java.io.File;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.function.Consumer;

import javax.imageio.ImageIO;
import javax.swing.BoxLayout;
import javax.swing.ImageIcon;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTabbedPane;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.SwingWorker;

import jakarta.json.Json;
import jakarta.json.JsonArray;
import jakarta.json.JsonObject;

/**
 * RocketPy's plots and its live API, in the same tab as the flight summary.
 * <p>
 * Both work on the objects the last flight was built from, held by the sidecar,
 * so a plot or a line of Python always describes the flight that is on screen.
 * Nothing here re-implements RocketPy: the plots are RocketPy's own functions
 * written to PNG, and the console runs real Python against the same instances.
 */
public class RocketPyResultsPanel extends JPanel {

    private static final long serialVersionUID = 1L;
    private static final int PLOT_WIDTH = 560;

    private final JPanel plotsPanel = new JPanel();
    private final JTextArea consoleOutput = new JTextArea(8, 60);
    private final JTextField consoleInput = new JTextField();
    private final JButton runButton = new JButton("Run");

    private SidecarClient client;

    public RocketPyResultsPanel(Consumer<String> log) {
        super(new BorderLayout());
        setPreferredSize(new Dimension(600, 300));

        plotsPanel.setLayout(new BoxLayout(plotsPanel, BoxLayout.Y_AXIS));
        JScrollPane plotScroll = new JScrollPane(plotsPanel);

        consoleOutput.setEditable(false);
        consoleOutput.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        consoleOutput.setText("""
                RocketPy's own objects for the last flight are bound here:
                  environment, motor, rocket, flight
                and also np (numpy), plt (matplotlib) and rocketpy.

                Type Python below and press Run; anything printed appears here.""");

        JPanel consoleRow = new JPanel(new BorderLayout(6, 0));
        consoleRow.add(new JLabel(">>>"), BorderLayout.WEST);
        consoleRow.add(consoleInput, BorderLayout.CENTER);
        consoleRow.add(runButton, BorderLayout.EAST);

        JPanel console = new JPanel(new BorderLayout(0, 6));
        console.add(consoleRow, BorderLayout.NORTH);
        console.add(new JScrollPane(consoleOutput), BorderLayout.CENTER);

        JTabbedPane tabs = new JTabbedPane();
        tabs.addTab("Plots", plotScroll);
        tabs.addTab("Console", console);
        add(tabs, BorderLayout.CENTER);

        runButton.setEnabled(false);
        runButton.addActionListener(e -> runCode());
        consoleInput.addActionListener(e -> runCode());
        this.log = log;
    }

    private final Consumer<String> log;

    /** The sidecar to evaluate against; null disables the console. */
    public void setClient(SidecarClient client) {
        this.client = client;
        runButton.setEnabled(client != null && client.isRunning());
    }

    /** Replace the plots with those of the newest flight. */
    public void showPlots(JsonObject result) {
        plotsPanel.removeAll();
        JsonArray figures = result == null ? null : result.getJsonArray("figures");
        if (figures == null) {
            plotsPanel.add(new JLabel("RocketPy produced no plots for this flight."));
        } else {
            for (int i = 0; i < figures.size(); i++) {
                JsonObject figure = figures.getJsonObject(i);
                String path = figure.getString("path", null);
                if (path == null) {
                    JLabel failed = new JLabel(figure.getString("kind", "plot") + ": "
                            + figure.getString("error", "not produced"));
                    plotsPanel.add(failed);
                    continue;
                }
                JLabel image = loadPlot(path, figure.getString("title", figure.getString("kind", "plot")));
                plotsPanel.add(image);
            }
        }
        plotsPanel.revalidate();
        plotsPanel.repaint();
    }

    private JLabel loadPlot(String path, String title) {
        try {
            Image picture = ImageIO.read(new File(path));
            if (picture == null) {
                return new JLabel(title + ": the image file could not be read");
            }
            int height = (int) Math.round(picture.getHeight(null) * (PLOT_WIDTH / (double) picture.getWidth(null)));
            JLabel label = new JLabel(title, new ImageIcon(picture.getScaledInstance(
                    PLOT_WIDTH, height, Image.SCALE_SMOOTH)), JLabel.CENTER);
            label.setVerticalTextPosition(JLabel.BOTTOM);
            label.setHorizontalTextPosition(JLabel.CENTER);
            return label;
        } catch (Exception e) {
            return new JLabel(title + ": " + e.getMessage());
        }
    }

    private void runCode() {
        String code = consoleInput.getText();
        SidecarClient active = client;
        if (active == null || !active.isRunning() || code == null || code.isBlank()) {
            return;
        }

        consoleInput.setEditable(false);
        runButton.setEnabled(false);
        consoleOutput.append("\n>>> " + code);

        new SwingWorker<String, String>() {
            @Override
            protected String doInBackground() throws Exception {
                JsonObject params = Json.createObjectBuilder().add("code", code).build();
                JsonObject result = active.request("eval", params, SidecarClient.DEFAULT_TIMEOUT);
                return result.getString("output", "");
            }

            @Override
            protected void done() {
                consoleInput.setEditable(true);
                runButton.setEnabled(true);
                try {
                    String output = get();
                    consoleOutput.append("\n" + (output.isBlank() ? "(no output)" : output.stripTrailing()));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause();
                    consoleOutput.append("\n" + (cause == null ? e.toString() : cause.toString()));
                    log.accept("RocketPy code failed: " + (cause == null ? e : cause.getMessage()));
                }
                consoleInput.setText("");
                consoleOutput.setCaretPosition(consoleOutput.getDocument().getLength());
            }
        }.execute();
    }

    /** Test seam: the plots the panel is currently showing, by title. */
    public List<String> plotTitles() {
        return java.util.Arrays.stream(plotsPanel.getComponents())
                .filter(JLabel.class::isInstance)
                .map(component -> ((JLabel) component).getText())
                .toList();
    }
}
