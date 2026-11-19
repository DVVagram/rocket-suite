"""Flight tests: RocketPy flies a converted OpenRocket design.

Runs in a subprocess for the same reason as the conversion tests: a JVM started
inside the test process faults on Windows.

The comparison with OpenRocket's stored results is reported, not asserted: the
stored flight does not always describe the motor in the design, so a mismatch is
information about the design archive, not a RocketPy failure.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
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


def _convert_and_fly(design: Path) -> dict:
    out_file = Path(tempfile.mkdtemp(prefix="fly-test-")) / "result.json"
    script = "\n".join([
        "import json, sys",
        f"sys.path.insert(0, {str(REPO)!r})",
        "from pathlib import Path",
        "import builtins",
        "from sidecar import conversion",
        f"converted = conversion.convert({str(design)!r})",
        "blocked = ('jpype', 'orhelper', 'rocketserializer', 'net.sf.openrocket')",
        "original_import = builtins.__import__",
        "def blocked_import(name, *args, **kwargs):",
        "    if any(name == item or name.startswith(item + '.') for item in blocked):",
        "        raise AssertionError('blocked OpenRocket dependency imported: ' + name)",
        "    return original_import(name, *args, **kwargs)",
        "builtins.__import__ = blocked_import",
        "from sidecar import flight",
        "result = flight.fly(converted['parameters'])",
        "result['openrocket_imports_blocked'] = True",
        "result['reference'] = converted['reference']",
        "result['parameters'] = {'rocket': converted['parameters']['rocket']}",
        f"Path({str(out_file)!r}).write_text(json.dumps(result), encoding='utf-8')",
        "",
    ])
    completed = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=600
    )
    assert completed.returncode == 0, completed.stderr[-3000:]
    return json.loads(out_file.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def flown():
    return _convert_and_fly(SIMPLE)


@needs_runtime
def test_flight_returns_plausible_numbers(flown):
    flight = flown["flight"]
    assert flight["apogee_m"] and flight["apogee_m"] > 0
    assert flight["apogee_time_s"] and flight["apogee_time_s"] > 0
    assert flight["max_speed_m_s"] > 0
    assert flight["max_mach"] > 0
    assert flight["flight_time_s"] >= flight["apogee_time_s"]
    assert flight["out_of_rail_velocity_m_s"] > 0

    # A 60 g model rocket on the motor in this design: metres to a few hundred
    # metres, not kilometres and not centimetres.
    assert 5 < flight["apogee_m"] < 2000


@needs_runtime
def test_apogee_matches_the_speed_of_the_flight(flown):
    """A sanity check independent of OpenRocket: v^2 / 2g bounds the apogee."""
    flight = flown["flight"]
    ballistic_ceiling = flight["max_speed_m_s"] ** 2 / (2 * 9.81)
    assert flight["apogee_m"] <= ballistic_ceiling * 1.05, (
        "apogee above the drag-free ceiling means the integration is wrong"
    )


@needs_runtime
def test_events_are_reported_in_order(flown):
    events = flown["events"]
    assert [e["name"] for e in events], "a flight must report its events"
    times = [e["time_s"] for e in events if e.get("time_s") is not None]
    assert times == sorted(times), "events must be in flight order"
    assert any("parachute" in e["name"].lower() for e in events), "the parachute must deploy"


@needs_runtime
def test_flight_reports_its_assumptions(flown):
    report = flown["report"]
    joined = " ".join(report["approximations"]).lower()
    assert "wind" in joined, "still-air flight must say so"
    assert "drag" in joined, "the drag mapping must be stated"
    unsupported = " ".join(report["unsupported"]).lower()
    assert "body tube" in unsupported, "the missing airframe lift must be stated"


@needs_runtime
def test_static_margin_is_the_figure_at_launch(flown):
    """Stability means the value at ignition, not the largest one in the flight.

    The reported value used to be the maximum over the whole flight, which is
    reached after burnout when the propellant is gone. On this design that was
    8.5 cal against 7.6 at ignition, so the two figures are kept apart and the
    reported one must not be the larger.
    """
    flight = flown["flight"]
    launch = flight["static_margin_calibers"]
    largest = flight["static_margin_max_calibers"]
    assert launch is not None and largest is not None
    assert -10 < launch < 10, launch
    assert launch < largest, (launch, largest)


@needs_runtime
def test_openrocket_reference_is_not_used(flown):
    """The reference travels with the result for comparison only."""
    assert flown["reference"], "the OpenRocket reference should be available to compare"
    assert "stored_results" not in flown["parameters"]["rocket"]


@needs_runtime
def test_flight_runs_with_openrocket_dependencies_blocked(flown):
    """The actual RocketPy flight runs while every conversion dependency is blocked."""
    assert flown["openrocket_imports_blocked"] is True
