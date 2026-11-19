"""RocketPy's own plots, rendered to PNG files for the Swing tab.

The plotting code is RocketPy's; this module only supplies an off-screen
matplotlib backend and a place to write the images. Nothing here recomputes a
curve, so what the tab shows is exactly what RocketPy would show.
"""

from __future__ import annotations

from pathlib import Path

# Every plot RocketPy offers for a flight, in the order a reader wants them.
DEFAULT_KINDS = (
    "trajectory_3d",
    "linear_kinematics_data",
    "angular_kinematics_data",
    "aerodynamic_forces",
    "energy_data",
    "pressure_signals",
)


def render(flight, output_dir: Path, kinds: list[str] | None = None) -> list[dict]:
    """Call RocketPy's plot functions and save each figure."""
    if flight is None:
        raise ValueError("no flight to plot; fly the design first")

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plotter = getattr(flight, "plots", None)
    if plotter is None:
        raise ValueError("this RocketPy version exposes no plots for a flight")

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    produced = []
    for kind in kinds or DEFAULT_KINDS:
        function = getattr(plotter, kind, None)
        if function is None:
            produced.append({"kind": kind, "error": "not available in this RocketPy version"})
            continue
        plt.close("all")
        try:
            figure = function()
        except Exception as exc:  # a plot failing must not lose the flight
            produced.append({"kind": kind, "error": f"{type(exc).__name__}: {exc}"})
            plt.close("all")
            continue

        target = output_dir / f"{kind}.png"
        try:
            (figure if hasattr(figure, "savefig") else plt.gcf()).savefig(
                target, dpi=110, bbox_inches="tight"
            )
        except Exception as exc:
            produced.append({"kind": kind, "error": f"could not save the figure: {exc}"})
        else:
            produced.append({"kind": kind, "path": str(target), "title": _title(kind)})
        finally:
            plt.close("all")
    return produced


def _title(kind: str) -> str:
    return {
        "trajectory_3d": "Trajectory, 3D",
        "linear_kinematics_data": "Position, velocity and acceleration",
        "angular_kinematics_data": "Attitude and angular rates",
        "aerodynamic_forces": "Aerodynamic forces",
        "energy_data": "Energy",
        "pressure_signals": "Pressure signals",
    }.get(kind, kind.replace("_", " ").capitalize())
