"""Design conversion: .ork -> RocketPy parameters, via RocketSerializer.

No conversion logic is re-implemented here.  The module calls
RocketSerializer's own extractor (`ork_extractor`) on an OpenRocket document
opened through the same JPype session RocketSerializer uses, then records
everything the extractor could not represent so the UI can show it.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from .. import config
from . import jvm


class ConversionError(RuntimeError):
    """Raised when RocketSerializer cannot convert a design."""


def _prepare_ork(path: Path, workdir: Path) -> tuple[Path, "object"]:
    """Extract the design XML from a .ork container and parse it."""
    from rocketserializer._helpers import extract_ork_from_zip, parse_ork_file

    path = path.resolve()
    if path.suffix.lower() == ".ork":
        # RocketSerializer unpacks the container next to the file it is given,
        # so stage a copy in the work directory and keep the design folder clean.
        staged = workdir / path.name
        shutil.copy2(path, staged)
        extracted = Path(extract_ork_from_zip(staged, workdir))
    else:
        extracted = path
    bs, datapoints = parse_ork_file(extracted)
    return extracted, (bs, datapoints)


def convert(ork_path: Path, out_dir: Path) -> dict:
    """Convert an .ork file and return parameters plus a conversion report."""
    from rocketserializer.ork_extractor import ork_extractor

    out_dir.mkdir(parents=True, exist_ok=True)
    workdir = out_dir / "ork"
    workdir.mkdir(parents=True, exist_ok=True)

    extracted, (bs, datapoints) = _prepare_ork(ork_path, workdir)

    report = {
        "source": str(ork_path),
        "converter": "RocketSerializer",
        "warnings": [],
        "unsupported": [],
        "approximations": [],
        "openrocket_stored_results": {},
        "has_openrocket_flight_data": bool(len(datapoints)),
    }

    if not len(datapoints):
        # RocketSerializer needs the design's stored OpenRocket flight data.
        report["warnings"].append(
            "The design contains no stored OpenRocket simulation data. "
            "RocketSerializer derives mass properties from those results, so "
            "conversion needs a design that has been simulated in OpenRocket."
        )

    session = jvm.open_session()
    doc = session.load_doc(str(extracted))

    try:
        settings = ork_extractor(
            bs=bs,
            filepath=str(extracted),
            output_folder=str(out_dir),
            ork=doc,
        )
    except Exception as exc:  # surface, never swallow
        raise ConversionError(
            "RocketSerializer could not convert this design: "
            f"{type(exc).__name__}: {exc}"
        ) from exc

    params_path = out_dir / "parameters.json"
    params_path.write_text(
        json.dumps(settings, indent=4, sort_keys=True, ensure_ascii=False),
        encoding="utf-8",
    )

    _normalise_parachutes(settings, report)
    params_path.write_text(
        json.dumps(settings, indent=4, sort_keys=True, ensure_ascii=False),
        encoding="utf-8",
    )

    stored = settings.get("stored_results") or {}
    report["openrocket_stored_results"] = stored

    report["unsupported"].extend(_unsupported_components(bs))

    rocket = settings.get("rocket") or {}
    if rocket.get("center_of_mass_without_propellant") is None:
        report["approximations"].append(
            "Centre of mass without propellant was not extracted; RocketPy will "
            "use its own default."
        )
    for key in ("drag_curve", "thrust_source"):
        holder = rocket if key == "drag_curve" else (settings.get("motors") or {})
        value = holder.get(key)
        if isinstance(value, str) and not Path(value).is_file():
            report["warnings"].append(f"Missing generated file for {key}: {value}")

    report["parameters_path"] = str(params_path)
    report["motor"] = (settings.get("motors") or {}).get("thrust_source")
    return {"parameters": settings, "report": report, "params_path": params_path}


# Component elements RocketSerializer knows how to map into RocketPy.
_SUPPORTED_TAGS = {
    "nosecone",
    "bodytube",
    "transition",
    "trapezoidfinset",
    "ellipticalfinset",
    "freeformfinset",
    "tubeFinSet",
    "tubefinset",
    "parachute",
    "railbutton",
    "railbuttons",
    "innertube",
    "tubecoupler",
    "centeringring",
    "masscomponent",
    "shockcord",
    "launchlug",
    "bulkhead",
}


def _unsupported_components(bs) -> list[str]:
    """List OpenRocket components RocketSerializer cannot represent.

    Reporting is driven by the component elements actually present in the
    design, so an empty group (a design with no elliptical fins) is not
    mistaken for a conversion loss.
    """
    found: dict[str, int] = {}
    # Multi-stage/pod structures are not supported by RocketSerializer.
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
        f"The design uses {count} {label}, which RocketSerializer cannot map "
        "into RocketPy; that part of the geometry is not simulated."
        for label, count in sorted(found.items())
    ]


def _normalise_parachutes(settings: dict, report: dict) -> None:
    """Make OpenRocket deployment triggers expressible in RocketPy.

    OpenRocket's default ``ejection`` trigger (ejection charge, with a delay)
    has no direct RocketPy equivalent: RocketPy triggers are apogee, an
    altitude, or a signal.  Rather than dropping the parachute, it is mapped to
    the apogee trigger and the difference is reported as an approximation.
    """
    for index, chute in (settings.get("parachutes") or {}).items():
        event = chute.get("deploy_event")
        if event == "ejection":
            chute["deploy_event"] = "apogee"
            delay = chute.get("deploy_delay") or 0.0
            report["approximations"].append(
                f"Parachute '{chute.get('name', index)}' deploys on OpenRocket's "
                f"ejection event (delay {delay} s); it was mapped to RocketPy's "
                "apogee trigger, so the ejection delay is not modelled."
            )
        elif event not in {"apogee", "altitude"} and event is not None:
            chute["deploy_event"] = "apogee"
            report["unsupported"].append(
                f"Parachute '{chute.get('name', index)}' uses deployment trigger "
                f"'{event}', which RocketPy cannot express; it was mapped to "
                "apogee."
            )


def build_notebook(params_path: Path, out_dir: Path) -> Path:
    """Use RocketSerializer's notebook builder to express the design for RocketPy.

    This keeps the RocketPy object construction identical to what
    RocketSerializer itself generates, instead of hand-writing a second mapping.
    """
    from rocketserializer.nb_builder import NotebookBuilder

    NotebookBuilder(parameters_json=str(params_path)).build(destination=str(out_dir))
    notebooks = sorted(out_dir.glob("*.ipynb"))
    if not notebooks:
        raise ConversionError("RocketSerializer did not produce a notebook")
    return notebooks[-1]


def cleanup(out_dir: Path) -> None:
    shutil.rmtree(out_dir, ignore_errors=True)


__all__ = ["convert", "build_notebook", "cleanup", "ConversionError", "config"]
