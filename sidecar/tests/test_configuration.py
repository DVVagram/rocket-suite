"""Configuration selection: one design, several flights, no mixing.

The bundled example stores five configurations (A8, B4, three C6) with one
simulation each. Before this fix the converter paired one configuration's motor
with another configuration's stored flight: 8.8 N s next to a 50 m apogee.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
EXAMPLES = REPO / "core/src/main/resources/datafiles/examples"
SIMPLE = EXAMPLES / "A simple model rocket.ork"

sys.path.insert(0, str(REPO))
from sidecar import conversion  # noqa: E402

needs_runtime = pytest.mark.skipif(
    conversion.find_jar() is None or not SIMPLE.is_file(),
    reason="no OpenRocket jar or example design available",
)


def _xml() -> str:
    raw = SIMPLE.read_bytes()
    if raw[:2] == b"PK":
        return zipfile.ZipFile(SIMPLE).read("rocket.ork").decode("utf-8", "replace")
    return raw.decode("utf-8", "replace")


def _configurations() -> list[str]:
    import re

    return re.findall(r'<motorconfiguration configid="([^"]+)"', _xml())


def _stored_altitude_for(config_id: str) -> float:
    """The altitude OpenRocket itself recorded for that configuration's flight."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(_xml(), features="xml")
    for simulation in soup.find_all("simulation"):
        declared = simulation.find("conditions").find("configid").text.strip()
        if declared == config_id:
            branch = simulation.find("databranch")
            return float(branch.get("optimumAltitude"))
    raise AssertionError(f"no simulation for configuration {config_id}")


def _convert_with(config_id: str) -> dict:
    out_file = Path(tempfile.mkdtemp(prefix="cfg-test-")) / "result.json"
    script = "\n".join([
        "import json, sys",
        f"sys.path.insert(0, {str(REPO)!r})",
        "from pathlib import Path",
        "from sidecar import conversion",
        f"r = conversion.convert({str(SIMPLE)!r}, configuration={config_id!r})",
        f"Path({str(out_file)!r}).write_text(json.dumps(r), encoding='utf-8')",
        "",
    ])
    completed = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=300
    )
    assert completed.returncode == 0, completed.stderr[-2000:]
    return json.loads(out_file.read_text(encoding="utf-8"))


@needs_runtime
def test_only_the_selected_configuration_is_converted():
    configs = _configurations()
    assert len(configs) > 1, "the example must have several configurations to be meaningful"

    result = _convert_with(configs[0])
    report = result["report"]["configuration"]
    assert report["id"] == configs[0]
    assert report["remaining_simulations"] == 1
    assert report["removed_simulations"] == len(configs) - 1


@needs_runtime
def test_reference_belongs_to_the_selected_configuration():
    """The stored flight must be the one flown with *this* configuration's motor."""
    for config_id in (_configurations()[0], _configurations()[-1]):
        result = _convert_with(config_id)
        stored = result["reference"]["max_altitude"]
        expected = _stored_altitude_for(config_id)
        assert abs(stored - expected) < 0.5, (
            f"reference {stored} does not belong to configuration {config_id} "
            f"(its own flight reached {expected})"
        )


@needs_runtime
def test_different_configurations_give_different_flights():
    first, last = _convert_with(_configurations()[0]), _convert_with(_configurations()[-1])
    assert first["reference"]["max_altitude"] != last["reference"]["max_altitude"], (
        "picking a different configuration must change the flight"
    )

    def impulse(result) -> float:
        rows = [[float(x) for x in line.split(",")]
                for line in Path(result["parameters"]["motors"]["thrust_source"]).read_text().splitlines()
                if line.strip()]
        return sum(0.5 * (rows[i][1] + rows[i - 1][1]) * (rows[i][0] - rows[i - 1][0])
                   for i in range(1, len(rows)))

    assert impulse(first) < impulse(last), (
        "each configuration must bring its own motor: the A8 has less impulse than the C6"
    )


def test_unknown_configuration_is_rejected():
    """A stale id must fail loudly, not silently convert every configuration."""
    with pytest.raises(ValueError):
        conversion.convert(str(SIMPLE), configuration="not-a-real-configuration")
