"""Design conversion: OpenRocket .ork -> RocketPy parameters.

RocketSerializer does the conversion; this module only supplies what it needs
(an OpenRocket jar, a JVM, the saved design) and turns its output into a result
that keeps the three kinds of number apart:

* ``parameters`` - converted design values, the only thing the flight may read;
* ``reference``  - OpenRocket's own stored flight results, display only;
* ``report``     - what was lost, approximated or could not be represented.

Note on versions: RocketSerializer drives OpenRocket through
``net.sf.openrocket.*`` classes, the package layout of OpenRocket 22/23. The
suite forks 24.12, which renamed those packages to ``info.openrocket.core.*``,
so the sidecar deliberately loads a 23.09 jar for conversion.
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

ORK_JAR_ENV = "ROCKETSUITE_ORK_JAR"

_JAR_PATTERNS = (
    "vendor/openrocket/*.jar",
    ".integration-src/RocketSerializer/*.jar",
    "tools/openrocket/*.jar",
)

_session = None
_jar_used: Path | None = None


def _version(path: Path) -> tuple:
    match = re.search(r"(\d+(?:\.\d+)*)", path.name)
    return tuple(int(p) for p in match.group(1).split(".")) if match else (0,)


def _search_roots() -> list[Path]:
    roots, current = [], Path.cwd().resolve()
    for _ in range(4):
        roots.append(current)
        if current.parent == current:
            break
        current = current.parent
    return roots


def find_jar(explicit: str | None = None) -> Path | None:
    if explicit:
        candidate = Path(explicit)
        return candidate if candidate.is_file() else None

    env = os.environ.get(ORK_JAR_ENV)
    if env and Path(env).is_file():
        return Path(env)

    found: list[Path] = []
    for root in _search_roots():
        for pattern in _JAR_PATTERNS:
            found.extend(p for p in root.glob(pattern) if p.is_file())
    window_openrocket = Path("C:/Program Files/OpenRocket")
    if window_openrocket.is_dir():
        found.extend(window_openrocket.glob("*.jar"))
    if not found:
        return None
    return sorted(found, key=_version)[-1]


def find_java_home(explicit: str | None = None) -> str | None:
    """Locate a JVM for JPype: explicit, environment, the repository, then the OS."""
    for candidate in (explicit, os.environ.get("ROCKETSUITE_JAVA_HOME"), os.environ.get("JAVA_HOME")):
        if candidate and (Path(candidate) / "bin").is_dir():
            return candidate

    for root in _search_roots():
        for pattern in ("tools/*jre*", "tools/*jdk*", "jre*", "jdk*"):
            for directory in sorted(root.glob(pattern)):
                if (directory / "bin").is_dir():
                    return str(directory)

    for base in ("C:/Program Files/Java", "C:/Program Files/Eclipse Adoptium",
                 "C:/Program Files/Microsoft"):
        location = Path(base)
        if location.is_dir():
            for directory in sorted(location.glob("*")):
                if (directory / "bin").is_dir():
                    return str(directory)
    return None


def _open_session(java_home: str | None, jar: Path):
    """Start (once) the OpenRocket JVM that RocketSerializer talks to."""
    global _session, _jar_used
    if _session is not None:
        return _session

    home = find_java_home(java_home)
    if home is None:
        raise RuntimeError(
            "No JVM found for conversion. Set JAVA_HOME (a JRE 17 is enough) or pass "
            "java_home in the request."
        )
    os.environ["JAVA_HOME"] = home
    os.environ["PATH"] = str(Path(home) / "bin") + os.pathsep + os.environ.get("PATH", "")

    import orhelper

    instance = orhelper.OpenRocketInstance(str(jar), log_level="OFF")
    instance.__enter__()
    _session = (instance, orhelper.Helper(instance))
    _jar_used = jar
    return _session


def _normalise_parachutes(settings: dict, report: dict) -> None:
    """Make OpenRocket deployment triggers expressible in RocketPy.

    OpenRocket's default ``ejection`` trigger (charge with a delay) has no
    RocketPy equivalent: RocketPy triggers are apogee, an altitude or a signal.
    Mapping it to apogee is an approximation, so it is recorded, never hidden.
    """
    for index, chute in (settings.get("parachutes") or {}).items():
        event = chute.get("deploy_event")
        if event == "ejection":
            chute["deploy_event"] = "apogee"
            report["approximations"].append(
                f"Parachute '{chute.get('name', index)}' uses OpenRocket's ejection trigger "
                f"(delay {chute.get('deploy_delay') or 0.0} s); mapped to RocketPy's apogee "
                "trigger, so the delay is not modelled."
            )
        elif event not in {"apogee", "altitude"} and event is not None:
            chute["deploy_event"] = "apogee"
            report["unsupported"].append(
                f"Parachute '{chute.get('name', index)}' uses trigger '{event}', which RocketPy "
                "cannot express; mapped to apogee."
            )


def _unsupported_structures(bs) -> list[str]:
    found = {}
    for tag, label in (
        ("podset", "pods"),
        ("booster", "parallel boosters"),
        ("parallelstage", "parallel staging"),
        ("wing", "wings"),
    ):
        count = len(bs.find_all(tag))
        if count:
            found[label] = count
    return [
        f"The design uses {count} {label}, which RocketSerializer cannot map into "
        "RocketPy; that part of the geometry is not simulated."
        for label, count in sorted(found.items())
    ]


def _stored_flight(bs) -> dict:
    """Recover OpenRocket's own flight summary from its recorded datapoints.

    OpenRocket 24.12 writes the simulation summary without the attributes
    RocketSerializer looks for (`maxaltitude`, `maxvelocity`, ...), so on a file
    saved by this suite every comparison figure would arrive as 0. The points it
    does write are the same flight, so the figures are read from them - still
    OpenRocket's result, not a RocketPy one.
    """
    simulation = bs.find("simulation")
    branch = simulation.find("databranch") if simulation is not None else None
    if branch is None:
        return {}

    labels = [label.strip() for label in (branch.get("types") or "").split(",") if label.strip()]
    wanted = ("Time", "Altitude", "Total velocity", "Mach number", "Total acceleration")
    indices = {name: labels.index(name) for name in wanted if name in labels}
    if "Time" not in indices or "Altitude" not in indices:
        return {}

    rows = []
    for point in branch.find_all("datapoint"):
        values = point.text.split(",")
        try:
            row = {name: float(values[i]) for name, i in indices.items()}
        except (IndexError, ValueError):
            continue
        if any(value != value for value in row.values()):
            continue
        rows.append(row)
    if not rows:
        return {}

    peak = max(rows, key=lambda row: row["Altitude"])
    reference = {
        "max_altitude": peak["Altitude"],
        "time_to_apogee": peak["Time"],
        "flight_time": rows[-1]["Time"],
    }
    if "Total velocity" in indices:
        reference["max_velocity"] = max(row["Total velocity"] for row in rows)
        reference["ground_hit_velocity"] = rows[-1]["Total velocity"]
        rail = simulation.find("conditions")
        rail_length = rail.find("launchrodlength") if rail is not None else None
        try:
            length = float(rail_length.text) if rail_length is not None else 0.0
        except ValueError:
            length = 0.0
        off_rail = [row["Total velocity"] for row in rows if row["Altitude"] >= length]
        if off_rail:
            reference["launch_rod_velocity"] = off_rail[0]
    if "Mach number" in indices:
        reference["max_mach"] = max(row["Mach number"] for row in rows)
    if "Total acceleration" in indices:
        reference["max_acceleration"] = max(abs(row["Total acceleration"]) for row in rows)
    return reference


def _apply_java_fin_offsets(settings: dict, offsets: list[dict] | None, report: dict) -> None:
    """Replace serializer fin stations with OpenRocket's resolved axial offsets."""
    groups = {
        "trapezoidal": settings.get("trapezoidal_fins") or {},
        "elliptical": settings.get("elliptical_fins") or {},
    }
    for fins in groups.values():
        for fin in fins.values():
            fin["position_source"] = "RocketSerializer"

    if offsets is None:
        if any(groups.values()):
            report["warnings"].append(
                "OpenRocket fin offsets were not supplied; RocketSerializer fin positions "
                "are retained and may be inaccurate for staged designs."
            )
        return

    by_type = {kind: [entry for entry in offsets if entry.get("type") == kind] for kind in groups}
    for fin_type, fins in groups.items():
        ordered_fins = [value for _, value in sorted(fins.items(), key=lambda item: int(item[0]))]
        supplied = by_type[fin_type]
        if len(ordered_fins) != len(supplied) or any(
            fin.get("name") != entry.get("name")
            for fin, entry in zip(ordered_fins, supplied)
        ):
            if ordered_fins:
                report["warnings"].append(
                    f"OpenRocket fin offsets for {fin_type} sets did not match the converted "
                    "design by count and name; RocketSerializer positions were retained."
                )
            continue

        try:
            positions = [float(entry["axial_offset_m"]) for entry in supplied]
        except (KeyError, TypeError, ValueError):
            report["warnings"].append(
                f"OpenRocket returned an invalid axial offset for {fin_type} fins; "
                "RocketSerializer positions were retained."
            )
            continue

        for fin, position in zip(ordered_fins, positions):
            fin["position"] = position
            fin["position_source"] = "OpenRocket FinSet.getAxialOffset()"
        if ordered_fins:
            report["approximations"].append(
                f"Axial offsets for {fin_type} fin sets come from OpenRocket's "
                "FinSet.getAxialOffset(), in metres."
            )


def _design_summary(settings: dict) -> dict:
    rocket = settings.get("rocket") or {}
    return {
        "name": (settings.get("id") or {}).get("rocket_name"),
        "designer": (settings.get("id") or {}).get("designer"),
        "mass_kg": rocket.get("mass"),
        "radius_m": rocket.get("radius"),
        "centre_of_mass_m": rocket.get("center_of_mass_without_propellant"),
        "nose_cones": len(settings.get("nosecones") or {}),
        "fin_sets": len(settings.get("trapezoidal_fins") or {}) + len(settings.get("elliptical_fins") or {}),
        "parachutes": len(settings.get("parachutes") or {}),
    }


def convert(ork_path: str, java_home: str | None = None, jar_path: str | None = None,
            configuration: str | None = None, fin_offsets: list[dict] | None = None) -> dict:
    """Convert a saved .ork file and report exactly what happened.

    ``configuration`` is OpenRocket's id for the configuration the user is
    working in. When it is given, every other configuration and its simulations
    are removed before conversion, so the motor, the geometry and the stored
    flight all come from the same flight.
    """
    source = Path(ork_path)
    if not source.is_file():
        raise FileNotFoundError(f"design not found: {source}")

    jar = find_jar(jar_path)
    if jar is None:
        raise RuntimeError(
            "No OpenRocket jar found for conversion. RocketSerializer needs an "
            "OpenRocket 22/23 jar (24.12 renamed its packages); set "
            f"{ORK_JAR_ENV} or place one in vendor/openrocket/."
        )

    from rocketserializer._helpers import extract_ork_from_zip, parse_ork_file
    from rocketserializer.ork_extractor import ork_extractor

    from sidecar.ork_slice import keep_configuration

    workdir = Path(tempfile.mkdtemp(prefix="rocketsuite-conv-"))
    staged = workdir / source.name
    staged.write_bytes(source.read_bytes())
    extracted = Path(extract_ork_from_zip(staged, workdir)) if source.suffix.lower() == ".ork" else staged

    selection = None
    if configuration:
        sliced = workdir / f"design-{configuration}.ork"
        selection = keep_configuration(extracted, configuration, sliced)
        extracted = sliced

    bs, datapoints = parse_ork_file(extracted)

    report = {
        "converter": "RocketSerializer",
        "openrocket_jar": str(jar),
        "warnings": [],
        "unsupported": [],
        "approximations": [],
        "has_openrocket_flight_data": bool(len(datapoints)),
    }
    if selection is None:
        report["warnings"].append(
            "No configuration was selected, so every configuration and simulation in "
            "the design was converted together; the motor and the stored flight may "
            "come from different configurations."
        )
    else:
        report["configuration"] = selection
        if selection["remaining_simulations"] == 0:
            report["warnings"].append(
                "The selected configuration has no simulation of its own; run "
                "OpenRocket's simulation for it to give the conversion flight data."
            )
    if not len(datapoints):
        report["warnings"].append(
            "The design has no stored OpenRocket simulation. RocketSerializer derives mass "
            "properties from those results, so run OpenRocket's own simulation first."
        )

    instance, helper = _open_session(java_home, jar)
    document = helper.load_doc(str(extracted))

    try:
        settings = ork_extractor(
            bs=bs,
            filepath=str(extracted),
            output_folder=str(workdir),
            ork=document,
        )
    except Exception as exc:
        raise RuntimeError(f"RocketSerializer could not convert this design: {exc}") from exc

    _normalise_parachutes(settings, report)
    _apply_java_fin_offsets(settings, fin_offsets, report)
    report["unsupported"].extend(_unsupported_structures(bs))

    simulation = bs.find("simulation")
    if simulation is not None:
        name = simulation.find("name")
        report["flight_data"] = {"simulation": name.text.strip() if name else None}

    # Stored OpenRocket results are a reference for comparison, never an input.
    # RocketSerializer's own summary is kept where it is complete; the figures
    # recovered from the recorded points fill in what 24.12 stopped writing.
    from_serializer = settings.pop("stored_results", {}) or {}
    recovered = _stored_flight(bs)
    reference = {key: value for key, value in from_serializer.items() if value}
    reference.update(recovered)

    if not reference:
        report["warnings"].append("The design carries no stored OpenRocket flight results to compare against.")
    elif recovered and not from_serializer.get("max_altitude"):
        report["warnings"].append(
            "OpenRocket's saved summary is incomplete in this file's format, so the "
            "comparison figures were read from the flight points it recorded."
        )

    for chute in (settings.get("parachutes") or {}).values():
        if isinstance(chute, dict) and chute.get("cd") == "auto":
            chute["cd"] = 1.0

    return {
        "source": {"path": str(source), "file": source.name},
        "parameters": settings,
        "reference": reference,
        "report": report,
        "design": _design_summary(settings),
    }
