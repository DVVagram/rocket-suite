package info.openrocket.swing.gui.main;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Component;
import java.awt.Container;

import javax.swing.JTabbedPane;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import com.google.inject.AbstractModule;
import com.google.inject.Guice;
import com.google.inject.Injector;
import com.google.inject.Module;
import com.google.inject.util.Modules;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.OpenRocketDocumentFactory;
import info.openrocket.core.l10n.DebugTranslator;
import info.openrocket.core.l10n.Translator;
import info.openrocket.core.plugin.PluginModule;
import info.openrocket.core.preferences.ApplicationPreferences;
import info.openrocket.core.startup.Application;
import info.openrocket.swing.ServicesForTesting;
import info.openrocket.swing.gui.rocketpy.RocketPyPanel;
import info.openrocket.swing.gui.util.SwingPreferences;

/**
 * The RocketPy tab is the whole point of the fork: it must exist next to
 * OpenRocket's own tabs, and adding it must not disturb them.
 * <p>
 * Unlike {@code BaseTestCase}, this installs {@link SwingPreferences}: the
 * OpenRocket window builds Swing actions whose static initialisers cast the
 * preferences service to it, and the plain testing preferences fail that cast.
 */
public class RocketPyTabTest {

    @BeforeAll
    public static void setUp() {
        Module application = new ServicesForTesting();
        Module swingServices = new AbstractModule() {
            @Override
            protected void configure() {
                bind(Translator.class).toInstance(new DebugTranslator(null));
                bind(ApplicationPreferences.class).to(SwingPreferences.class);
            }
        };
        Injector injector = Guice.createInjector(Modules.override(application).with(swingServices),
                new PluginModule());
        Application.setInjector(injector);
    }

    @Test
    public void rocketPyTabSitsAfterOpenRocketTabs() {
        OpenRocketDocument document = OpenRocketDocumentFactory.createNewRocket();
        BasicFrame frame = new BasicFrame(document);
        try {
            JTabbedPane tabs = findTabbedPane(frame);
            assertNotNull(tabs, "BasicFrame must contain its tabbed pane");

            assertEquals(4, tabs.getTabCount(), "three OpenRocket tabs plus the RocketPy tab");
            // The test translator renders titles as "[Class.key]", so match the keys.
            assertTrue(tabs.getTitleAt(0).contains("BasicFrame.tab.Rocketdesign"));
            assertTrue(tabs.getTitleAt(1).contains("BasicFrame.tab.Flightconfig"));
            assertTrue(tabs.getTitleAt(2).contains("BasicFrame.tab.Flightsim"));
            assertTrue(tabs.getTitleAt(3).contains("BasicFrame.tab.RocketPy"));

            assertTrue(tabs.getComponentAt(3) instanceof RocketPyPanel,
                    "the fourth tab must be the RocketPy panel");
            assertNotNull(((RocketPyPanel) tabs.getComponentAt(3)).getResultsPanel(),
                    "the RocketPy tab must carry RocketPy's plots and console");
            assertTrue(tabs.getComponentAt(0) instanceof DesignPanel,
                    "OpenRocket's design tab must be untouched");
        } finally {
            frame.dispose();
        }
    }

    private static JTabbedPane findTabbedPane(Container container) {
        for (Component child : container.getComponents()) {
            if (child instanceof JTabbedPane tabbedPane) {
                return tabbedPane;
            }
            if (child instanceof Container nested) {
                JTabbedPane found = findTabbedPane(nested);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }
}
