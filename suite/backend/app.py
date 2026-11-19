"""Unified rocket engineering suite - HTTP surface.

One Python process serves the SPA and the JSON API.  Engines are imported
lazily so that opening the app costs neither a JVM nor RocketPy.
"""

from __future__ import annotations

import shutil
import tempfile
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, projects
from .engines import convert, simulate

FRONTEND = config.SUITE_DIR / "frontend"

app = FastAPI(title="Unified Rocket Suite", version="0.1.0")


class DesignRequest(BaseModel):
    path: str | None = None
    project_id: str | None = None


class SimulateRequest(DesignRequest):
    settings: dict | None = None
    save_project: bool = False
    project_name: str | None = None


class ProjectRequest(BaseModel):
    name: str
    ork_path: str | None = None
    design_b64: str | None = None
    conversion: dict | None = None
    simulations: list | None = None
    settings: dict | None = None
    id: str | None = None


def _design_path(request: DesignRequest) -> Path:
    if request.project_id:
        path = projects.materialise_design(request.project_id)
    elif request.path:
        path = Path(request.path)
    else:
        raise HTTPException(400, "Provide either a design path or a project id")
    if not path.is_file():
        raise HTTPException(404, f"Design not found: {path}")
    return path


@app.get("/api/health")
def health() -> dict:
    status = config.runtime_status()
    status["engines"] = {
        "design": "OpenRocket (via JPype)",
        "conversion": "RocketSerializer",
        "flight": "RocketPy",
    }
    return status


@app.get("/api/examples")
def examples() -> dict:
    if not config.EXAMPLES_DIR.is_dir():
        return {"examples": []}
    return {
        "examples": [
            {"name": p.stem, "path": str(p), "size": p.stat().st_size}
            for p in sorted(config.EXAMPLES_DIR.glob("*.ork"))
        ]
    }


@app.post("/api/design/open")
def open_design(request: DesignRequest) -> dict:
    path = _design_path(request)
    out_dir = Path(tempfile.mkdtemp(prefix="orsuite-conv-", dir=config.WORKSPACE_DIR))
    try:
        converted = convert.convert(path, out_dir)
    except Exception as exc:
        raise HTTPException(422, f"{exc}") from exc
    params = converted["parameters"]
    rocket = params.get("rocket", {})
    motors = params.get("motors", {})
    def group(key: str) -> list[dict]:
        """RocketSerializer writes indexed groups, but a lone nose cone is a flat dict."""
        value = params.get(key) or {}
        if isinstance(value, dict):
            if {"length", "kind", "name"} & set(value):
                return [value]
            return [v for v in value.values() if isinstance(v, dict)]
        return [v for v in value if isinstance(v, dict)]

    surfaces = {
        "nosecones": group("nosecones"),
        "trapezoidal_fins": group("trapezoidal_fins"),
        "elliptical_fins": group("elliptical_fins"),
        "parachutes": group("parachutes"),
    }
    return {
        "design": {
            "path": str(path),
            "name": params.get("id", {}).get("rocket_name") or path.stem,
            "designer": params.get("id", {}).get("designer"),
            "mass": rocket.get("mass"),
            "radius": rocket.get("radius"),
            "inertia": rocket.get("inertia"),
            "centre_of_mass": rocket.get("center_of_mass_without_propellant"),
            "motor_position": motors.get("position"),
            "surfaces": surfaces,
            "openrocket_results": params.get("stored_results") or {},
        },
        "conversion": converted["report"],
        "workspace": str(out_dir),
    }


def _run_flight(path: Path, settings: dict | None) -> dict:
    out_dir = Path(tempfile.mkdtemp(prefix="orsuite-sim-", dir=config.WORKSPACE_DIR))
    started = time.perf_counter()
    try:
        result = simulate.run(path, out_dir, settings)
    except Exception as exc:
        traceback.print_exc()
        shutil.rmtree(out_dir, ignore_errors=True)
        raise HTTPException(500, f"Simulation failed: {type(exc).__name__}: {exc}") from exc
    result["elapsed_seconds"] = round(time.perf_counter() - started, 2)
    result["design_path"] = str(path)
    shutil.rmtree(out_dir, ignore_errors=True)
    return result


@app.post("/api/simulate")
def run_simulation(request: SimulateRequest) -> dict:
    path = _design_path(request)
    result = _run_flight(path, request.settings)
    if request.save_project:
        saved = projects.save({
            "name": request.project_name or path.stem,
            "ork_path": str(path),
            "conversion": result["report"],
            "simulations": [{
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "summary": result["summary"],
                "events": result["events"],
                "series": result["series"],
                "comparison": result["comparison"],
                "settings": request.settings or {},
            }],
            "settings": request.settings or {},
        })
        result["project"] = saved
    return result


@app.get("/api/projects")
def list_projects() -> dict:
    return {"projects": projects.list_projects()}


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    try:
        return projects.load(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "Project not found") from exc


@app.post("/api/projects")
def create_project(request: ProjectRequest) -> dict:
    return projects.save(request.model_dump())


@app.exception_handler(Exception)
def unhandled(_request, exc: Exception) -> JSONResponse:  # pragma: no cover
    return JSONResponse(status_code=500, content={"detail": str(exc)})


if FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
