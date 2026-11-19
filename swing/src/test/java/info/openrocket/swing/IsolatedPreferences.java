package info.openrocket.swing;

/**
 * Keep test settings out of the user's OpenRocket preferences.
 * <p>
 * OpenRocket stores its settings in the Java preference node named by
 * {@code SwingPreferences}; a test that installs {@code SwingPreferences} would
 * otherwise write into the user's real configuration, and the application could
 * open on its welcome dialog afterwards instead of a blank rocket.
 * <p>
 * {@code java.util.prefs.userRoot} cannot help here: on Windows the preference
 * root is the registry and that property is ignored. The node name is a system
 * property instead, so the tests get a node of their own.
 */
public final class IsolatedPreferences {

    /** The node the tests write to, instead of the user's. */
    public static final String TEST_NODE = "OpenRocket-tests";

    private static boolean installed;

    private IsolatedPreferences() {
    }

    /** Must run before the first {@code SwingPreferences} is constructed. */
    public static synchronized void install() {
        if (installed) {
            return;
        }
        System.setProperty("openrocket.preferences.node", TEST_NODE);
        installed = true;
        System.out.println("[tests] preferences node: " + TEST_NODE);
    }

    /** True when tests are writing to their own node rather than the user's. */
    public static boolean isIsolated() {
        return TEST_NODE.equals(System.getProperty("openrocket.preferences.node"));
    }
}
