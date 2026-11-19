"""RocketPy's plots and console, exercised against a real flight.

One subprocess converts, flies, renders the plots and runs a line of Python, for
the same reason as the other runtime tests: the JVM must not start in-process.
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


def _fly_with_plots() -> dict:
    out_file = Path(tempfile.mkdtemp(prefix="plot-test-")) / "result.json"
    script = "\n".join([
        "import json, sys",
        f"sys.path.insert(0, {str(REPO)!r})",
        "from pathlib import Path",
        "from sidecar import conversion, flight",
        f"converted = conversion.convert({str(SIMPLE)!r})",
        "flight.fly(converted['parameters'])",
        "figures = flight.plots(['trajectory_3d', 'linear_kinematics_data'])",
        "answer = flight.evaluate('print(round(flight.apogee, 1)); print(type(rocket).__name__)')",
        f"Path({str(out_file)!r}).write_text(json.dumps({{'figures': figures, 'answer': answer}}), encoding='utf-8')",
        "",
    ])
    completed = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=600
    )
    assert completed.returncode == 0, completed.stderr[-3000:]
    return json.loads(out_file.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def rendered():
    return _fly_with_plots()


@needs_runtime
def test_plots_are_written_as_images(rendered):
    figures = [f for f in rendered["figures"]["figures"] if "path" in f]
    assert len(figures) >= 2, rendered["figures"]
    for figure in figures:
        path = Path(figure["path"])
        assert path.is_file() and path.stat().st_size > 5000, f"{figure['kind']} looks empty"
        assert path.suffix == ".png"


@needs_runtime
def test_console_sees_the_flown_objects(rendered):
    output = rendered["answer"]["output"]
    assert float(output.splitlines()[0]) > 0, "the console must see the real flight"
    assert "Rocket" in output, "the rocket object must be bound in the console namespace"
    assert "rocket" in rendered["answer"]["names"]


def test_plotting_without_a_flight_is_refused():
    from sidecar import flight as runtime

    runtime._SESSION.clear()
    with pytest.raises(ValueError):
        runtime.plots(["trajectory_3d"])
