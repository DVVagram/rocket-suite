"""Reduce a saved .ork to a single flight configuration.

OpenRocket stores every configuration side by side in one file: each has its own
motor, and each simulation belongs to exactly one configuration. RocketSerializer
reads the motor from one place and the stored flight from another, so on a
multi-configuration design it can pair a motor with a flight that was never flown
with it - a C6's thrust curve next to an A8 flight's apogee.

Handing the converter a file that contains only the configuration the user is
working in removes the ambiguity entirely, instead of trying to reconcile the
numbers afterwards.
"""

from __future__ import annotations

from pathlib import Path

from bs4 import BeautifulSoup


def keep_configuration(source: Path, config_id: str, target: Path) -> dict:
    """Write ``source`` to ``target`` with every other configuration removed."""
    soup = BeautifulSoup(source.read_text(encoding="utf-8"), features="xml")

    kept_configurations = 0
    for element in soup.find_all("motorconfiguration"):
        if element.get("configid") == config_id:
            kept_configurations += 1
        else:
            element.decompose()

    for motor in soup.find_all("motor"):
        if motor.get("configid") != config_id:
            motor.decompose()

    removed_simulations = 0
    for simulation in soup.find_all("simulation"):
        conditions = simulation.find("conditions")
        declared = conditions.find("configid") if conditions else None
        if declared is not None and declared.text.strip() != config_id:
            simulation.decompose()
            removed_simulations += 1

    if kept_configurations == 0:
        raise ValueError(
            f"configuration {config_id} is not in this design; it may have been "
            "deleted or renamed since the flight was set up"
        )

    target.write_text(str(soup), encoding="utf-8")
    return {
        "id": config_id,
        "removed_simulations": removed_simulations,
        "remaining_simulations": len(soup.find_all("simulation")),
    }
