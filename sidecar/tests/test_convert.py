"""Conversion tests: real RocketSerializer, real OpenRocket jar, real design.

The conversion starts a JVM, which faults when started inside the test process
on Windows, so every conversion here runs in a subprocess - the same shape the
application uses, where the sidecar is a separate process too.

Skipped when no jar or no example design is present, so the suite still runs on
a machine that has not provisioned the conversion runtime.
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


def _convert_in_subprocess(design: Path) -> dict:
    """Convert in a separate process and bring the result back as JSON."""
    out_file = Path(tempfile.mkdtemp(prefix="conv-test-")) / "result.json"
    script = "\n".join([
        "import json, sys",
        f"sys.path.insert(0, {str(REPO)!r})",
        "from pathlib import Path",
        "from sidecar import conversion",
        f"result = conversion.convert({str(design)!r})",
        f"Path({str(out_file)!r}).write_text(json.dumps(result), encoding='utf-8')",
        "",
    ])
    completed = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=300
    )
    assert completed.returncode == 0, completed.stderr[-2000:]
    return json.loads(out_file.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def converted():
    return _convert_in_subprocess(SIMPLE)


@needs_runtime
def test_conversion_returns_design_values_and_report(converted):
    params = converted["parameters"]
    assert params["rocket"]["mass"] > 0
    assert params["rocket"]["radius"] > 0
    fins = next(iter(params["trapezoidal_fins"].values()))
    assert fins["number"] >= 2

    assert set(converted["report"]) >= {"warnings", "unsupported", "approximations"}
    assert converted["report"]["converter"] == "RocketSerializer"
    assert converted["report"]["has_openrocket_flight_data"] is True
    assert converted["design"]["name"]


@needs_runtime
def test_stored_results_are_reference_only(converted):
    assert "stored_results" not in converted["parameters"], (
        "OpenRocket's own flight results must never travel with the flight inputs"
    )
    assert converted["reference"], "the comparison reference should be reported separately"


@needs_runtime
def test_parachute_triggers_are_rocketpy_compatible(converted):
    triggers = {c["deploy_event"] for c in converted["parameters"]["parachutes"].values()}
    assert triggers <= {"apogee", "altitude"}
    if any("ejection" in note for note in converted["report"]["approximations"]):
        assert triggers == {"apogee"}, "an ejection trigger must be mapped, not dropped"


@needs_runtime
def test_generated_files_exist_for_the_flight(converted):
    rocket = converted["parameters"]["rocket"]
    assert Path(rocket["drag_curve"]).is_file(), "drag curve must be generated"
    assert Path(converted["parameters"]["motors"]["thrust_source"]).is_file()


def test_missing_design_is_reported():
    with pytest.raises(FileNotFoundError):
        conversion.convert(str(EXAMPLES / "does-not-exist.ork"))


@needs_runtime
def test_convert_over_the_wire():
    """The protocol path the Java client uses, exercised end to end."""
    sidecar = Path(__file__).resolve().parents[1] / "rocketpy_sidecar.py"
    # stderr must be drained or discarded: the JVM logs far more than a pipe
    # buffer holds, and a child blocked writing it never answers.
    process = subprocess.Popen(
        [sys.executable, str(sidecar)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", bufsize=1,
    )
    try:
        assert json.loads(process.stdout.readline())["event"] == "ready"
        process.stdin.write(json.dumps({
            "id": "c1",
            "method": "convert",
            "params": {"ork": str(SIMPLE), "java_home": None},
        }) + "\n")
        process.stdin.flush()
        response = json.loads(process.stdout.readline())
        assert response["ok"] is True, response.get("error")
        assert response["result"]["parameters"]["rocket"]["mass"] > 0
    finally:
        process.stdin.close()
        process.kill()
