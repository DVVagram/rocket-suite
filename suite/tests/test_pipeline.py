"""Integration tests for the unified suite.

The flight test runs the real pipeline: OpenRocket (through RocketSerializer's
JPype driver) -> RocketSerializer conversion -> RocketPy flight.  It needs the
Java runtime and the OpenRocket jar, so it is skipped when they are absent.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from suite.backend import config, projects  # noqa: E402
from suite.backend.engines import convert, simulate  # noqa: E402

EXAMPLE = config.EXAMPLES_DIR / "A simple model rocket.ork"
runtime = config.runtime_status()
needs_runtime = pytest.mark.skipif(
    not (runtime["ok"] and EXAMPLE.is_file()),
    reason="Java runtime or OpenRocket jar not available",
)


def test_runtime_is_discoverable():
    status = config.runtime_status()
    assert status["python"].startswith("3.")
    assert isinstance(status["examples"], list)
    if status["ok"]:
        assert Path(status["jar"]).is_file()


@needs_runtime
def test_design_converts_to_rocketpy_parameters(tmp_path):
    result = convert.convert(EXAMPLE, tmp_path)
    params = result["parameters"]
    assert params["rocket"]["mass"] > 0
    assert params["rocket"]["radius"] > 0
    assert params["nosecones"]["base_radius"] > 0
    # Component groups are keyed by integer index in memory, by string in JSON.
    fins = next(iter(params["trapezoidal_fins"].values()))
    assert fins["number"] >= 2
    assert Path(params["motors"]["thrust_source"]).is_file()
    assert Path(params["rocket"]["drag_curve"]).is_file()
    # Conversion losses are reported, never silently dropped.
    assert set(result["report"]) >= {"warnings", "unsupported", "approximations"}


@needs_runtime
def test_parachute_trigger_is_explicit():
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        result = convert.convert(EXAMPLE, Path(tmp))
    events = [c["deploy_event"] for c in result["parameters"]["parachutes"].values()]
    assert events and all(e in {"apogee", "altitude"} for e in events)


@needs_runtime
def test_full_flight_returns_rocketpy_results(tmp_path):
    flight = simulate.run(EXAMPLE, tmp_path)
    summary = flight["summary"]
    assert summary["apogee"] and summary["apogee"] > 0
    assert summary["flight_time"] > 0
    series = flight["series"]
    lengths = {len(v) for v in series.values() if v}
    assert len(lengths) == 1, "every channel must share the same time base"
    assert any(e["name"] == "Apogee" for e in flight["events"])
    assert flight["engine"]["flight"] == "RocketPy"


def test_project_round_trip_preserves_design(tmp_path, monkeypatch):
    monkeypatch.setattr(projects.config, "PROJECTS_DIR", tmp_path)
    monkeypatch.setattr(projects.config, "WORKSPACE_DIR", tmp_path)
    design_bytes = b"<rocket>original</rocket>"
    source = tmp_path / "design.ork"
    source.write_bytes(design_bytes)

    saved = projects.save({"name": "Round trip", "ork_path": str(source),
                           "simulations": [{"summary": {"apogee": 123.4}}]})
    loaded = projects.load(saved["id"])

    assert Path(loaded["design_path"]).read_bytes() == design_bytes
    assert base64.b64encode(design_bytes).decode() in (
        tmp_path / f"{saved['id']}.orsuite"
    ).read_text()


def test_project_index_lists_saved_projects(tmp_path, monkeypatch):
    monkeypatch.setattr(projects.config, "PROJECTS_DIR", tmp_path)
    monkeypatch.setattr(projects.config, "WORKSPACE_DIR", tmp_path)
    projects.save({"name": "Indexed", "design_b64": base64.b64encode(b"x").decode()})
    listed = projects.list_projects()
    assert listed and listed[0]["name"] == "Indexed"
