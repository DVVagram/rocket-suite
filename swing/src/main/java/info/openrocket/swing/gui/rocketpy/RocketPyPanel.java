package info.openrocket.swing.gui.rocketpy;

import java.awt.BorderLayout;
import java.awt.Font;

import javax.swing.BorderFactory;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;

import info.openrocket.core.document.OpenRocketDocument;

/**
 * Panel for the "RocketPy" tab.
 * <p>
 * The tab is a sibling of OpenRocket's own "Rocket design", "Motors &amp;
 * Configuration" and "Flight simulations" tabs: OpenRocket remains the host
 * application and stays responsible for the design, while this panel drives the
 * Python sidecar that runs RocketPy.
 * <p>
 * At this stage the panel only displays state; the sidecar protocol is added
 * separately. It deliberately contains no engineering logic of its own: every
 * number shown here must come from RocketPy, and nothing here may read or write
 * design values.
 */
public class RocketPyPanel extends JPanel {

    private static final long serialVersionUID = 1L;

    /** OpenRocket document this panel belongs to (unused until the bridge lands). */
    private final OpenRocketDocument document;

    private final JLabel statusLabel;
    private final JTextArea logArea;

    public RocketPyPanel(OpenRocketDocument document) {
        super(new BorderLayout(0, 8));
        this.document = document;

        setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));

        JLabel title = new JLabel("RocketPy flight");
        title.setFont(title.getFont().deriveFont(Font.BOLD, title.getFont().getSize2D() + 3f));

        statusLabel = new JLabel("Not connected");

        JPanel header = new JPanel(new BorderLayout());
        header.add(title, BorderLayout.NORTH);
        header.add(statusLabel, BorderLayout.SOUTH);

        logArea = new JTextArea();
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
                results are shown for comparison and are never read by RocketPy.""");

        add(header, BorderLayout.NORTH);
        add(new JScrollPane(logArea), BorderLayout.CENTER);
    }

    public OpenRocketDocument getDocument() {
        return document;
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
