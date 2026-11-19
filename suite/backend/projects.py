"""Shared project files (.orsuite).

A project stores provenance explicitly:

* ``design.ork``      the OpenRocket file, byte-for-byte as it was opened;
* ``conversion``      what RocketSerializer produced, plus its warnings;
* ``simulations``     RocketPy results, each tied to the conversion it used.

Opening a project never rewrites the design, and the original design values
always remain available next to the converted and simulated ones.
"""

from __future__ import annotations

import base64
import json
import time
import uuid
from pathlib import Path

from . import config

VERSION = 1


def _index_path() -> Path:
    return config.PROJECTS_DIR / "index.json"


def list_projects() -> list[dict]:
    index = _index_path()
    if not index.is_file():
        return []
    return json.loads(index.read_text(encoding="utf-8")).get("projects", [])


def _write_index(projects: list[dict]) -> None:
    _index_path().write_text(json.dumps({"projects": projects}, indent=2), encoding="utf-8")


def project_path(project_id: str) -> Path:
    return config.PROJECTS_DIR / f"{project_id}.orsuite"


def save(payload: dict) -> dict:
    project_id = payload.get("id") or uuid.uuid4().hex[:12]
    ork_path = payload.get("ork_path")
    design_b64 = payload.get("design_b64")
    if ork_path and not design_b64:
        design_b64 = base64.b64encode(Path(ork_path).read_bytes()).decode("ascii")

    record = {
        "version": VERSION,
        "id": project_id,
        "name": payload.get("name") or "Untitled rocket",
        "created": payload.get("created") or time.strftime("%Y-%m-%dT%H:%M:%S"),
        "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "design": {
            "file": Path(ork_path).name if ork_path else f"{project_id}.ork",
            "ork_b64": design_b64,
        },
        "conversion": payload.get("conversion"),
        "simulations": payload.get("simulations") or [],
        "settings": payload.get("settings") or {},
    }
    project_path(project_id).write_text(json.dumps(record, indent=1), encoding="utf-8")

    projects = [p for p in list_projects() if p["id"] != project_id]
    projects.insert(0, {
        "id": project_id,
        "name": record["name"],
        "updated": record["updated"],
        "runs": len(record["simulations"]),
        "apogee": (record["simulations"][0]["summary"]["apogee"]
                   if record["simulations"] else None),
    })
    _write_index(projects)
    return {"id": project_id, "name": record["name"]}


def load(project_id: str) -> dict:
    path = project_path(project_id)
    if not path.is_file():
        raise FileNotFoundError(project_id)
    record = json.loads(path.read_text(encoding="utf-8"))
    design = record.get("design", {})
    if design.get("ork_b64"):
        target = config.WORKSPACE_DIR / f"{project_id}.ork"
        target.write_bytes(base64.b64decode(design["ork_b64"]))
        record["design_path"] = str(target)
    record.pop("design", None)
    return record


def materialise_design(project_id: str) -> Path:
    """Restore a project's .ork to disk and return its path."""
    return Path(load(project_id)["design_path"])
