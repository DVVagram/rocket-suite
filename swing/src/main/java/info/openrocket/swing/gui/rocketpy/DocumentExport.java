package info.openrocket.swing.gui.rocketpy;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.util.Iterator;
import java.nio.file.Path;

import jakarta.json.Json;
import jakarta.json.JsonArray;
import jakarta.json.JsonArrayBuilder;
import jakarta.json.JsonObjectBuilder;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.StorageOptions;
import info.openrocket.core.file.openrocket.OpenRocketSaver;
import info.openrocket.core.logging.ErrorSet;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.rocketcomponent.EllipticalFinSet;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.TrapezoidFinSet;

/**
 * Exports the open design to a temporary {@code .ork} file so the flight engine
 * can read it.
 * <p>
 * This is the only path by which a design reaches RocketPy: OpenRocket writes
 * its own file format, and the conversion happens entirely on the Python side.
 * Nothing is written into the user's document or file, and the design is saved
 * as it currently stands, including unsaved edits.
 */
public final class DocumentExport {

    private DocumentExport() {
    }

    /**
     * The id of the configuration the user is working in.
     * <p>
     * A design stores every configuration side by side, each with its own motor,
     * and each simulation belongs to one of them. Naming the configuration here
     * is what lets the converter take the motor, the geometry and the stored
     * flight from the same one.
     */
    public static String selectedConfigurationId(OpenRocketDocument document) {
        FlightConfiguration configuration = document.getSelectedConfiguration();
        return configuration == null ? null : configuration.getId().toString();
    }

    /** A human-readable name for the selected configuration, for the report. */
    public static String selectedConfigurationName(OpenRocketDocument document) {
        FlightConfiguration configuration = document.getSelectedConfiguration();
        if (configuration == null) {
            return null;
        }
        String name = configuration.getName();
        return name == null || name.isBlank() ? configuration.getNameRaw() : name;
    }

    /**
     * Export fin axial offsets resolved by OpenRocket in the rocket's coordinate frame.
     * The serializer's stage-relative fin positions can be wrong for staged designs.
     */
    public static JsonArray finAxialOffsets(OpenRocketDocument document) {
        JsonArrayBuilder offsets = Json.createArrayBuilder();
        Iterator<RocketComponent> components = document.getRocket().iterator();
        while (components.hasNext()) {
            RocketComponent component = components.next();
            if (!(component instanceof FinSet fin)) {
                continue;
            }
            String type;
            if (fin instanceof TrapezoidFinSet) {
                type = "trapezoidal";
            } else if (fin instanceof EllipticalFinSet) {
                type = "elliptical";
            } else {
                continue;
            }
            JsonObjectBuilder entry = Json.createObjectBuilder()
                    .add("type", type)
                    .add("name", fin.getName())
                    .add("axial_offset_m", fin.getAxialOffset());
            offsets.add(entry);
        }
        return offsets.build();
    }

    /**
     * Write the live document to a new temporary file.
     * <p>
     * Flight data is forced on for this copy. OpenRocket saves only simulation
     * summaries by default, but the converter derives mass and aerodynamic
     * properties from the sampled points, so a summary-only file cannot be flown.
     * The user's own save settings are untouched: this is a private copy.
     *
     * @return the file, for the caller to delete when it is no longer needed
     * @throws IOException if the design cannot be written
     */
    public static Path saveToTemp(OpenRocketDocument document) throws IOException {
        Path target = Files.createTempFile("rocketsuite-design-", ".ork");
        ErrorSet errors = new ErrorSet();
        WarningSet warnings = new WarningSet();
        StorageOptions options = document.getDefaultStorageOptions().clone();
        options.setSaveSimulationData(true);
        try (OutputStream out = Files.newOutputStream(target)) {
            new OpenRocketSaver().save(out, document, options, warnings, errors);
        }
        if (Files.size(target) == 0) {
            Files.deleteIfExists(target);
            throw new IOException("OpenRocket wrote an empty design file");
        }
        return target;
    }
}
