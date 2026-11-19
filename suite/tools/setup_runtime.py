"""Fetch the runtime pieces the suite does not vendor in git.

* a JRE 17 (Temurin, Windows x64) into ``tools/`` - OpenRocket 23+ needs Java 17;
* an OpenRocket jar into ``vendor/openrocket/`` for the JPype bridge.

Nothing here needs administrator rights, and nothing is installed system-wide.
Both steps are skipped when the files are already present.
"""

from __future__ import annotations

import argparse
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS = REPO_ROOT / "tools"
JAR_DIR = REPO_ROOT / "vendor" / "openrocket"

JRE_URL = (
    "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse"
)
JAR_URL = (
    "https://github.com/openrocket/openrocket/releases/download/"
    "release-23.09/OpenRocket-23.09.jar"
)


def _download(url: str, target: Path) -> None:
    print(f"downloading {url}")
    with urllib.request.urlopen(url, timeout=300) as response:
        target.write_bytes(response.read())
    print(f"  -> {target} ({target.stat().st_size / 1e6:.1f} MB)")


def ensure_jre() -> None:
    existing = sorted(TOOLS.glob("*jre*"))
    if any((d / "bin").is_dir() for d in existing):
        print("JRE already present in tools/")
        return
    TOOLS.mkdir(parents=True, exist_ok=True)
    archive = TOOLS / "jre17.zip"
    _download(JRE_URL, archive)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(TOOLS)
    archive.unlink(missing_ok=True)
    print("JRE extracted into tools/")


def ensure_jar() -> None:
    if any(JAR_DIR.glob("*.jar")):
        print("OpenRocket jar already present in vendor/openrocket/")
        return
    JAR_DIR.mkdir(parents=True, exist_ok=True)
    _download(JAR_URL, JAR_DIR / "OpenRocket-23.09.jar")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jre-only", action="store_true")
    parser.add_argument("--jar-only", action="store_true")
    args = parser.parse_args()
    if not args.jar_only:
        ensure_jre()
    if not args.jre_only:
        ensure_jar()
    print("\nDone. Start the suite with: python suite/run.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
