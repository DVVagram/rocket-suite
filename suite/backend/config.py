"""Runtime configuration for the unified rocket suite.

Everything is discovered locally; nothing is downloaded at import time.
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import sys
from pathlib import Path

SUITE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SUITE_DIR.parent
DATA_DIR = SUITE_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"
WORKSPACE_DIR = DATA_DIR / "workspace"
EXAMPLES_DIR = REPO_ROOT / "core" / "src" / "main" / "resources" / "datafiles" / "examples"

for d in (DATA_DIR, PROJECTS_DIR, WORKSPACE_DIR):
    d.mkdir(parents=True, exist_ok=True)


def _candidates(patterns: list[str]) -> list[Path]:
    out: list[Path] = []
    for pattern in patterns:
        out.extend(Path(p) for p in sorted(glob.glob(str(REPO_ROOT / pattern))))
    return out


def find_jar() -> Path | None:
    """OpenRocket jar used by the JPype bridge (RocketSerializer's own driver)."""
    env = os.environ.get("ORK_JAR")
    candidates = []
    if env:
        candidates.append(Path(env))
    candidates += _candidates([
        "vendor/openrocket/*.jar",
        ".integration-src/RocketSerializer/*.jar",
        "tools/openrocket/*.jar",
    ])
    # Also accept jars shipped next to an installed rocketserializer checkout.
    try:
        import rocketserializer  # noqa: F401

        pkg = Path(rocketserializer.__file__).resolve().parent.parent
        candidates += sorted(pkg.glob("OpenRocket-*.jar"))
    except Exception:
        pass
    def version(path: Path) -> tuple:
        match = re.search(r"(\d+(?:\.\d+)*)", path.name)
        return tuple(int(p) for p in match.group(1).split(".")) if match else (0,)

    existing = [c for c in candidates if c.is_file()]
    if not existing:
        return None
    # Several jars may be around (22.02, 23.09, 24.12); use the newest.
    return sorted(existing, key=version)[-1]


def find_jvm() -> Path | None:
    """Directory containing bin/server/jvm.dll (a JRE or JDK 17)."""
    env = os.environ.get("JAVA_HOME")
    if env and (Path(env) / "bin").is_dir():
        return Path(env)
    roots = [
        REPO_ROOT / "tools",
        Path("C:/Program Files/Java"),
        Path("C:/Program Files/Eclipse Adoptium"),
        Path("C:/Program Files/Microsoft"),
    ]
    for root in roots:
        if not root.is_dir():
            continue
        for d in sorted(root.glob("*jre*")) + sorted(root.glob("*jdk*")):
            if (d / "bin").is_dir():
                return d
    which = shutil.which("java")
    if which:
        return Path(which).resolve().parent.parent
    return None


def runtime_status() -> dict:
    jar = find_jar()
    jvm = find_jvm()
    return {
        "python": sys.version.split()[0],
        "ok": bool(jar and jvm),
        "jar": str(jar) if jar else None,
        "jar_mb": round(jar.stat().st_size / 1e6, 1) if jar else None,
        "java_home": str(jvm) if jvm else None,
        "examples_dir": str(EXAMPLES_DIR),
        "examples": sorted(p.name for p in EXAMPLES_DIR.glob("*.ork")) if EXAMPLES_DIR.is_dir() else [],
    }


def configure_java() -> None:
    """Point JPype at the discovered JVM before it starts."""
    jvm = find_jvm()
    if jvm is None:
        raise RuntimeError(
            "No Java runtime found. Install a JRE 17 or place one under tools/ "
            "(see suite/README.md)."
        )
    os.environ["JAVA_HOME"] = str(jvm)
    os.environ["PATH"] = str(jvm / "bin") + os.pathsep + os.environ.get("PATH", "")
