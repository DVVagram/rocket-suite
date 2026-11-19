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


def convert(ork_path: str, java_home: str | None = None, jar_path: str | None = None) -> dict:
    """Convert a saved .ork file and report exactly what happened."""
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

    workdir = Path(tempfile.mkdtemp(prefix="rocketsuite-conv-"))
    staged = workdir / source.name
    staged.write_bytes(source.read_bytes())
    extracted = Path(extract_ork_from_zip(staged, workdir)) if source.suffix.lower() == ".ork" else staged

    bs, datapoints = parse_ork_file(extracted)

    report = {
        "converter": "RocketSerializer",
        "openrocket_jar": str(jar),
        "warnings": [],
        "unsupported": [],
        "approximations": [],
        "has_openrocket_flight_data": bool(len(datapoints)),
    }
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
    report["unsupported"].extend(_unsupported_structures(bs))

    # Stored OpenRocket results are a reference for comparison, never an input.
    reference = settings.pop("stored_results", {}) or {}
    if not reference:
        report["warnings"].append("The design carries no stored OpenRocket flight results to compare against.")

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
