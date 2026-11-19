"""Start the unified rocket suite.

    python suite/run.py [--port 8099] [--no-browser]
"""

from __future__ import annotations

import argparse
import sys
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from suite.backend import config  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the unified rocket suite")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    status = config.runtime_status()
    print(f"python      {status['python']}")
    print(f"openrocket  {status['jar'] or 'missing'}")
    print(f"java home   {status['java_home'] or 'missing'}")
    if not status["ok"]:
        print("\nDesign and conversion need a JRE 17 and an OpenRocket jar;")
        print("run `python suite/tools/setup_runtime.py` or see suite/README.md.")

    config.configure_java()

    import uvicorn

    url = f"http://{args.host}:{args.port}/"
    print(f"\nRocket Suite on {url}")
    if not args.no_browser:
        webbrowser.open(url)
    uvicorn.run("suite.backend.app:app", host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
