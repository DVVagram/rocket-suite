"""Flight: RocketPy from converted OpenRocket parameters.

This module owns the physics and nothing else. It reads a parameters dictionary
produced by :mod:`sidecar.conversion` - OpenRocket's geometry, mass, inertia,
centre of mass and drag curve - and asks RocketPy for the flight. It imports no
OpenRocket class and no JPype: RocketPy's results cannot be contaminated by
OpenRocket's own simulation, because nothing here can reach it.

Every value that had to be substituted or ignored is returned in ``report``.
"""

from __future__ import annotations

import inspect
import time

_OGIVE_KINDS = {"ogive", "cone", "parabolic", "power"}
_RAPID_FORWARD = {"ogive": "ogive", "vonkarman": "ogive", "lvhaack": "ogive",
                  "lv-haack": "ogive", "haack": "ogive", "elliptical": "parabolic"}


def _version() -> str:
    from importlib.metadata import version

    try:
        return version("rocketpy")
    except Exception:  # pragma: no cover - metadata is present in any real install
        return "unknown"


def _accepted(target) -> set[str]:
    """Parameter names a RocketPy constructor or method actually takes."""
    return {
        name
        for name, param in inspect.signature(target).parameters.items()
        if name != "self" and param.kind is not inspect.Parameter.VAR_KEYWORD
    }


def _subset(mapping: dict, allowed: set[str]) -> dict:
    return {key: value for key, value in (mapping or {}).items() if key in allowed}


def _number(value):
    """JSON-safe number: RocketPy returns numpy scalars, which json cannot write."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _environment(values: dict, report: dict):
    from rocketpy import Environment

    environment = Environment(
        latitude=values.get("latitude", 0.0),
        longitude=values.get("longitude", 0.0),
        elevation=values.get("elevation", 0.0) or 0.0,
    )
    environment.set_atmospheric_model(type="standard_atmosphere")

    if values.get("wind_average"):
        report["approximations"].append(
            f"No wind is modelled. The design carries a {values['wind_average']:.1f} m/s "
            "average wind, which OpenRocket applies to its own flight; RocketPy is "
            "flown in still air so the two are not conflated."
        )
    return environment


def _motor(values: dict, report: dict):
    from rocketpy import SolidMotor

    if not values.get("thrust_source"):
        raise ValueError("the converted design carries no motor thrust curve")

    kwargs = _subset(values, _accepted(SolidMotor.__init__))
    kwargs.pop("reference_pressure", None)
    motor = SolidMotor(**kwargs)
    report["approximations"].append(
        f"Motor '{values.get('thrust_source', '').split(chr(92))[-1].split('/')[-1]}' is flown "
        "as a solid motor with the grain geometry OpenRocket reports."
    )
    return motor


def _rocket(values: dict, report: dict):
    from rocketpy import Rocket

    drag = values.get("drag_curve")
    if not drag:
        raise ValueError("the converted design carries no drag curve")

    kwargs = {
        "radius": values["radius"],
        "mass": values["mass"],
        "inertia": values["inertia"],
        "power_off_drag": drag,
        "power_on_drag": drag,
        "center_of_mass_without_motor": values.get("center_of_mass_without_propellant", 0.0),
        "coordinate_system_orientation": values.get("coordinate_system_orientation", "nose_to_tail"),
    }
    report["approximations"].append(
        "OpenRocket's drag curve is used for powered and unpowered flight alike: it is "
        "the whole-flight drag OpenRocket computed for this design, not a separate "
        "powered curve."
    )
    report["unsupported"].append(
        "RocketPy has no surface for a body tube: it computes lift from the nose cone and "
        "the fins only. Its centre of pressure therefore sits further forward than "
        "OpenRocket's, and the static margin it reports is smaller than OpenRocket's for "
        "the same design. OpenRocket's own flight, where the file stores one, is the figure "
        "to compare against stability."
    )
    report["unsupported"].append(
        "The fin positions are the converter's, taken from RocketSerializer, and are not "
        "checked against the design's own geometry; on some designs they sit behind the "
        "tail. Read the stability below as RocketPy's result for the geometry it was given, "
        "not as a verdict on the design."
    )
    return Rocket(**_subset(kwargs, _accepted(Rocket.__init__)))


def _nose(rocket, values: dict, report: dict) -> None:
    if not values:
        return
    kind = (values.get("kind") or "ogive").lower()
    mapped = kind if kind in _OGIVE_KINDS else _RAPID_FORWARD.get(kind, "ogive")
    if mapped != kind:
        report["approximations"].append(
            f"Nose cone profile '{kind}' has no RocketPy equivalent and is flown as '{mapped}'."
        )
    kwargs = _subset(values, _accepted(rocket.add_nose))
    kwargs["kind"] = mapped
    rocket.add_nose(**kwargs)


def _fins(rocket, parameters: dict, report: dict) -> None:
    trapezoidal = parameters.get("trapezoidal_fins") or {}
    for fin in trapezoidal.values():
        kwargs = {key: value for key, value in fin.items() if key != "number"}
        kwargs["n"] = fin.get("number", 3)
        rocket.add_trapezoidal_fins(**_subset(kwargs, _accepted(rocket.add_trapezoidal_fins)))

    elliptical = parameters.get("elliptical_fins") or {}
    if elliptical:
        report["unsupported"].append(
            f"{len(elliptical)} elliptical fin set(s) cannot be added to RocketPy and are "
            "not in the flight; the design's fin count and stability come from OpenRocket."
        )

    if not trapezoidal and not elliptical:
        report["unsupported"].append(
            "The design carries no fins RocketPy can model, so the flight has no fin lift."
        )


def _parachutes(rocket, values: dict, report: dict) -> list[str]:
    names = []
    for index, chute in (values or {}).items():
        trigger_kind = chute.get("deploy_event")
        if trigger_kind == "altitude" and chute.get("deploy_altitude") is not None:
            altitude = float(chute["deploy_altitude"])
            trigger = lambda height, state, altitude=altitude: height <= altitude  # noqa: E731
        else:
            trigger = "apogee"

        kwargs = {
            "name": chute.get("name") or f"parachute-{index}",
            "cd_s": chute.get("cds") or (chute.get("cd") or 1.0) * (chute.get("area") or 0.0),
            "trigger": trigger,
            "lag": chute.get("deploy_delay") or 0.0,
        }
        rocket.add_parachute(**_subset(kwargs, _accepted(rocket.add_parachute)))
        names.append(kwargs["name"])

        if kwargs["lag"]:
            report["approximations"].append(
                f"Parachute '{kwargs['name']}' opens with RocketPy's lag of {kwargs['lag']:.2f} s, "
                "interpreted from OpenRocket's deployment delay."
            )
    return names


def _static_margin_at_launch(rocket) -> float | None:
    """Stability at ignition, in calibers - the figure OpenRocket reports.

    The previous version fell back to the largest value over the whole flight,
    which is reached after burnout when the propellant is gone; it read 8.5 cal
    against OpenRocket's 3.2 for the same design and looked like a physics
    error.
    """
    try:
        return _number(rocket.static_margin(0.0))
    except Exception:
        return _max_function(rocket.static_margin)


def _events(flight, parachute_names: list[str]) -> list[dict]:
    events = []
    try:
        events.append({
            "name": "Apogee",
            "time_s": _number(flight.apogee_time),
            "altitude_m": _number(flight.apogee),
        })
    except Exception:  # pragma: no cover - apogee is always present in a normal flight
        pass

    for item in getattr(flight, "parachute_events", None) or []:
        try:
            moment, chute = item
            events.append({
                "name": f"{getattr(chute, 'name', 'parachute')} deployed",
                "time_s": _number(moment),
                "altitude_m": _number(flight.z(moment)),
            })
        except Exception:
            continue
    return events


def _max(fn, *args):
    try:
        return abs(_number(fn(*args)))
    except Exception:
        return None


def _max_function(function):
    """Peak of a RocketPy Function, or None when it has no usable maximum."""
    if function is None:
        return None
    try:
        peak = getattr(function, "max", None)
        if peak is None and callable(function):
            peak = function.max()
        return None if peak is None else abs(_number(peak))
    except Exception:
        return None


# The last objects built, so plots and user code work on the same flight
# instead of silently re-flying a different one.
_SESSION: dict = {}


def last_flight():
    return _SESSION.get("flight")


def plots(kinds: list[str] | None = None) -> dict:
    """Render RocketPy's own plots for the last flight to PNG files."""
    import tempfile

    from sidecar import plots as plotting

    if not _SESSION:
        raise ValueError("no flight has been run yet; fly the design first")
    output = tempfile.mkdtemp(prefix="rocketsuite-plots-")
    figures = plotting.render(_SESSION["flight"], output, kinds)
    return {"figures": figures, "directory": output}


def evaluate(code: str) -> dict:
    """Run RocketPy code against the last flight.

    This is the full RocketPy API on the user's own machine: the namespace holds
    the environment, motor, rocket and flight that were just built, plus numpy
    and matplotlib. It runs whatever is asked, which is the point.
    """
    import contextlib
    import io

    if not _SESSION:
        raise ValueError("no flight has been run yet; fly the design first")

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    import rocketpy

    namespace = {
        "rocketpy": rocketpy,
        "np": np,
        "plt": plt,
        "environment": _SESSION.get("environment"),
        "motor": _SESSION.get("motor"),
        "rocket": _SESSION.get("rocket"),
        "flight": _SESSION.get("flight"),
    }

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        exec(code, namespace)  # noqa: S102 - deliberate: the user's own code

    return {"output": buffer.getvalue(), "names": sorted(
        name for name in namespace if name not in {"rocketpy", "np", "plt"})}


def fly(parameters: dict, overrides: dict | None = None) -> dict:
    """Fly the converted design in RocketPy and return numbers, events and caveats."""
    overrides = overrides or {}
    if not isinstance(parameters, dict) or "rocket" not in parameters:
        raise ValueError("fly needs converted parameters (run convert first)")

    from rocketpy import Flight

    report: dict[str, list[str]] = {"approximations": [], "unsupported": [], "warnings": []}
    started = time.time()

    environment = _environment(parameters.get("environment") or {}, report)
    motor = _motor(parameters.get("motors") or {}, report)
    rocket = _rocket(parameters["rocket"], report)

    motor_position = (parameters.get("motors") or {}).get("position")
    rocket.add_motor(motor, position=motor_position or 0.0)

    _nose(rocket, parameters.get("nosecones") or {}, report)
    _fins(rocket, parameters, report)
    parachute_names = _parachutes(rocket, parameters.get("parachutes") or {}, report)

    conditions = parameters.get("flight") or {}
    launch = {
        "rail_length": overrides.get("rail_length", conditions.get("rail_length", 1.0)),
        "inclination": overrides.get("inclination", conditions.get("inclination", 90.0)),
        "heading": overrides.get("heading", conditions.get("heading", 90.0)),
    }
    flight = Flight(
        rocket=rocket,
        environment=environment,
        rail_length=launch["rail_length"],
        inclination=launch["inclination"],
        heading=launch["heading"],
        name=(parameters.get("id") or {}).get("rocket_name") or "RocketPy flight",
        max_time=overrides.get("max_time", 600),
    )

    summary = {
        "apogee_m": _number(flight.apogee),
        "apogee_time_s": _number(flight.apogee_time),
        "max_speed_m_s": _max(lambda: flight.max_speed),
        "max_mach": _max(lambda: flight.max_mach_number),
        "max_acceleration_m_s2": _max_function(getattr(flight, "acceleration", None)),
        "flight_time_s": _number(getattr(flight, "t_final", None)),
        "out_of_rail_velocity_m_s": _max(lambda: flight.out_of_rail_velocity),
        "static_margin_calibers": _static_margin_at_launch(rocket),
        "static_margin_max_calibers": _max_function(rocket.static_margin),
    }

    _SESSION.clear()
    _SESSION.update({
        "environment": environment,
        "motor": motor,
        "rocket": rocket,
        "flight": flight,
        "parameters": parameters,
    })

    return {
        "flight": summary,
        "events": _events(flight, parachute_names),
        "conditions": launch,
        "report": report,
        "seconds": round(time.time() - started, 2),
        "rocketpy_version": _version(),
    }
