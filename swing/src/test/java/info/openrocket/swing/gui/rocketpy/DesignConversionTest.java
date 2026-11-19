package info.openrocket.swing.gui.rocketpy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Optional;
import java.util.stream.Stream;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import com.google.inject.AbstractModule;
import com.google.inject.Guice;
import com.google.inject.Injector;
import com.google.inject.Module;
import com.google.inject.Provider;
import com.google.inject.util.Modules;

import jakarta.json.Json;
import jakarta.json.JsonArray;
import jakarta.json.JsonObject;

import info.openrocket.core.database.MotorDatabaseLoader;
import info.openrocket.core.database.motor.MotorDatabase;
import info.openrocket.core.database.motor.ThrustCurveMotorSetDatabase;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.OpenRocketDocumentFactory;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.l10n.DebugTranslator;
import info.openrocket.core.l10n.Translator;
import info.openrocket.core.plugin.PluginModule;
import info.openrocket.core.preferences.ApplicationPreferences;
import info.openrocket.core.startup.Application;
import info.openrocket.swing.IsolatedPreferences;
import info.openrocket.swing.ServicesForTesting;
import info.openrocket.swing.gui.util.SwingPreferences;

/**
 * The seam the whole integration rests on: OpenRocket's <em>own</em> saver
 * output must be accepted by the converter, and the converted values must be
 * saner than "something came back".
 * <p>
 * Skipped when the conversion runtime (Python, sidecar, an OpenRocket 23 jar) or
 * the bundled example design is missing.
 */
public class DesignConversionTest {

    private static Path example;
    private static MotorDatabaseLoader motorLoader;

    @BeforeAll
    public static void setUp() {
        // Before any preferences exist, so the user's own settings stay untouched.
        IsolatedPreferences.install();

        Module application = new ServicesForTesting();
        // Loading a design resolves its motor by name, so the real motor database
        // must be present: an empty one would load the design without its motor.
        motorLoader = new MotorDatabaseLoader();
        Module databases = new AbstractModule() {
            @Override
            protected void configure() {
                Provider<ThrustCurveMotorSetDatabase> motors = () -> {
                    motorLoader.blockUntilLoaded();
                    return motorLoader.getDatabase();
                };
                bind(ThrustCurveMotorSetDatabase.class).toProvider(motors);
                bind(MotorDatabase.class).toProvider(motors);
            }
        };
        Module swingServices = new AbstractModule() {
            @Override
            protected void configure() {
                bind(Translator.class).toInstance(new DebugTranslator(null));
                bind(ApplicationPreferences.class).to(SwingPreferences.class);
            }
        };
        Injector injector = Guice.createInjector(
                Modules.override(application).with(swingServices, databases),
                new PluginModule());
        Application.setInjector(injector);
        // Started only now: the loading thread resolves preferences through the
        // injector, exactly as the application starts it after registering its own.
        motorLoader.startLoading();

        example = findExample().orElse(null);
    }

    @Test
    public void savedOpenRocketDesignConvertsIntoFlightParameters() throws Exception {
        Optional<Path> python = SidecarClient.findPython();
        Optional<Path> script = SidecarClient.findScript();
        assumeTrue(python.isPresent() && script.isPresent(), "no Python or sidecar script");
        assumeTrue(example != null, "no bundled example design");
        assumeTrue(conversionJar().isPresent(), "no OpenRocket jar for the converter");
        // Diagram-heavy examples need a display; this one is a plain 3FNC design.

        OpenRocketDocument document = new GeneralRocketLoader(example.toFile()).load();
        Path staged = DocumentExport.saveToTemp(document);
        assumeTrue(Files.size(staged) > 0, "OpenRocket produced no design file");

        JsonArray finOffsets = DocumentExport.finAxialOffsets(document);
        try (SidecarClient client = new SidecarClient(python.get(), script.get(), line -> { })) {
            client.start();
            JsonObject result = client.request("convert", Json.createObjectBuilder()
                    .add("ork", staged.toString())
                    .add("java_home", System.getProperty("java.home"))
                    .add("configuration", DocumentExport.selectedConfigurationId(document))
                    .add("fin_offsets", finOffsets)
                    .build(), Duration.ofSeconds(240));

            JsonObject parameters = result.getJsonObject("parameters");
            assertNotNull(parameters, "a conversion must return parameters");

            JsonObject rocket = parameters.getJsonObject("rocket");
            assertTrue(rocket.getJsonNumber("mass").doubleValue() > 0.0, "mass must be positive");
            assertTrue(rocket.getJsonNumber("radius").doubleValue() > 0.0, "radius must be positive");

            JsonObject fins = parameters.getJsonObject("trapezoidal_fins");
            assertNotNull(fins, "the example design has trapezoidal fins");
            assertEquals(3, fins.values().iterator().next().asJsonObject().getInt("number"),
                    "a 3FNC design has three fins");

            boolean checkedFinOffset = false;
            for (int i = 0; i < finOffsets.size(); i++) {
                JsonObject offset = finOffsets.getJsonObject(i);
                if (!"trapezoidal".equals(offset.getString("type"))) {
                    continue;
                }
                boolean matched = false;
                for (jakarta.json.JsonValue value : fins.values()) {
                    JsonObject fin = value.asJsonObject();
                    if (offset.getString("name").equals(fin.getString("name"))) {
                        assertEquals(offset.getJsonNumber("axial_offset_m").doubleValue(),
                                fin.getJsonNumber("position").doubleValue(), 1.0e-9,
                                "the converted fin position must come from OpenRocket");
                        matched = true;
                    }
                }
                assertTrue(matched, "every OpenRocket trapezoidal fin offset must match a converted fin");
                checkedFinOffset = true;
            }
            assertTrue(checkedFinOffset, "the example must include a trapezoidal fin offset");

            JsonObject chute = parameters.getJsonObject("parachutes").values().iterator().next().asJsonObject();
            assertEquals("apogee", chute.getString("deploy_event"),
                    "OpenRocket's ejection trigger must arrive as a RocketPy trigger");

            assertFalse(parameters.containsKey("stored_results"),
                    "OpenRocket's flight results must not travel with the flight inputs");
            assertFalse(result.getJsonObject("reference").isEmpty(),
                    "OpenRocket's results are kept, separately, for comparison");
        } finally {
            Files.deleteIfExists(staged);
        }
    }

    @Test
    public void convertedDesignFliesAndReportsItsAssumptions() throws Exception {
        Optional<Path> python = SidecarClient.findPython();
        Optional<Path> script = SidecarClient.findScript();
        assumeTrue(python.isPresent() && script.isPresent(), "no Python or sidecar script");
        assumeTrue(example != null, "no bundled example design");
        assumeTrue(conversionJar().isPresent(), "no OpenRocket jar for the converter");

        OpenRocketDocument document = new GeneralRocketLoader(example.toFile()).load();
        Path staged = DocumentExport.saveToTemp(document);
        try (SidecarClient client = new SidecarClient(python.get(), script.get(), line -> { })) {
            client.start();
            JsonObject converted = client.request("convert", Json.createObjectBuilder()
                    .add("ork", staged.toString())
                    .add("java_home", System.getProperty("java.home"))
                    .add("configuration", DocumentExport.selectedConfigurationId(document))
                    .build(), Duration.ofSeconds(240));

            JsonObject flown = client.request("fly", Json.createObjectBuilder()
                    .add("parameters", converted.getJsonObject("parameters"))
                    .build(), Duration.ofSeconds(300));

            JsonObject flight = flown.getJsonObject("flight");
            assertTrue(flight.getJsonNumber("apogee_m").doubleValue() > 0.0, "apogee must be positive");
            assertTrue(flight.getJsonNumber("max_speed_m_s").doubleValue() > 0.0, "speed must be positive");
            assertTrue(flight.getJsonNumber("flight_time_s").doubleValue()
                    >= flight.getJsonNumber("apogee_time_s").doubleValue(),
                    "the flight must last at least until apogee");
            assertFalse(flown.getJsonArray("events").isEmpty(), "the flight must report its events");
            assertFalse(flown.getJsonObject("report").getJsonArray("approximations").isEmpty(),
                    "a flight must state what it approximated");

            // Both engines now describe the same configuration, so their apogees
            // must be close; before the configuration was passed through, they
            // differed by a factor of six on this very design.
            JsonObject reference = converted.getJsonObject("reference");
            double openRocket = reference.getJsonNumber("max_altitude").doubleValue();
            double rocketPy = flight.getJsonNumber("apogee_m").doubleValue();
            double difference = Math.abs(rocketPy - openRocket) / openRocket;
            assertTrue(difference < 0.10,
                    String.format("apogee %.1f m differs from OpenRocket's %.1f m by %.1f %%",
                            rocketPy, openRocket, difference * 100));
        } finally {
            Files.deleteIfExists(staged);
        }
    }

    @Test
    public void exportWritesAFileOpenRocketCanReadBack() throws Exception {
        OpenRocketDocument document = OpenRocketDocumentFactory.createNewRocket();
        Path staged = DocumentExport.saveToTemp(document);
        try {
            assertTrue(Files.size(staged) > 0, "a saved design must not be empty");
            OpenRocketDocument reloaded = new GeneralRocketLoader(staged.toFile()).load();
            assertEquals(document.getRocket().getName(), reloaded.getRocket().getName(),
                    "the exported file must be a design OpenRocket itself can read");
        } finally {
            Files.deleteIfExists(staged);
        }
    }

    private static Optional<Path> findExample() {
        for (Path base : roots()) {
            Path candidate = base.resolve("core/src/main/resources/datafiles/examples/A simple model rocket.ork");
            if (Files.isRegularFile(candidate)) {
                return Optional.of(candidate);
            }
        }
        return Optional.empty();
    }

    private static Optional<Path> conversionJar() {
        for (Path base : roots()) {
            for (String folder : new String[] { ".integration-src/RocketSerializer", "vendor/openrocket" }) {
                Path directory = base.resolve(folder);
                if (!Files.isDirectory(directory)) {
                    continue;
                }
                try (Stream<Path> jars = Files.list(directory)) {
                    Optional<Path> found = jars.filter(p -> p.toString().endsWith(".jar")).findFirst();
                    if (found.isPresent()) {
                        return found;
                    }
                } catch (java.io.IOException ignored) {
                    // try the next root
                }
            }
        }
        return Optional.empty();
    }

    private static Iterable<Path> roots() {
        java.util.List<Path> roots = new java.util.ArrayList<>();
        Path current = new File(System.getProperty("user.dir", ".")).toPath().toAbsolutePath();
        for (int depth = 0; depth < 4 && current != null; depth++) {
            roots.add(current);
            current = current.getParent();
        }
        return roots;
    }
}
