#!/usr/bin/env python3
"""RocketPy sidecar for the Rocket Suite.

The sidecar is a separate process on purpose: RocketPy and its scientific stack
stay out of the OpenRocket JVM, and the flight engine cannot touch OpenRocket's
design values.

Protocol (see README.md): newline-delimited JSON on stdin/stdout.

    -> {"id": "1", "method": "health", "params": {}}
    <- {"id": "1", "ok": true, "result": {...}}
    <- {"id": "1", "ok": false, "error": {"type": "...", "message": "..."}}

Only complete lines that are valid JSON frames are written to the protocol
stream. Everything else - library prints, warnings, Java output from JPype
later on - is redirected to stderr at the *file descriptor* level, because
JPype writes through fd 1 and would otherwise corrupt the frames.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import traceback

PROTOCOL_VERSION = 1

# Keep a private handle on the real stdout, then point fd 1 (and Python's
# sys.stdout) at stderr. Protocol frames are the only thing on the real stdout.
_protocol_fd = os.dup(1)
os.dup2(2, 1)
sys.stdout = sys.stderr  # noqa: A001 - deliberate
_PROTOCOL = os.fdopen(_protocol_fd, "w", encoding="utf-8", buffering=1)


def _package_version(name: str) -> str | None:
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:
        return None


def send(payload: dict) -> None:
    _PROTOCOL.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTOCOL.flush()


def _health(params: dict) -> dict:
    """Report what the sidecar can see, without importing the heavy stack."""
    return {
        "protocol": PROTOCOL_VERSION,
        "engine": "rocketpy",
        "python": platform.python_version(),
        "executable": sys.executable,
        "platform": platform.platform(),
        "rocketpy": _package_version("rocketpy"),
        "rocketserializer": _package_version("rocketserializer"),
        "mu_symbol": "\u00b5",  # proves the stream is UTF-8 end to end
    }


def _convert(params: dict) -> dict:
    """Convert the saved design to RocketPy parameters (S3)."""
    ork = params.get("ork")
    if not ork:
        raise ValueError("convert needs 'ork' (path to a saved .ork file)")

    # Imported lazily: the conversion stack (jpype, RocketSerializer, a JVM) is
    # heavy and is only needed once a design is actually converted.
    sys.path.insert(0, str(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    from sidecar import conversion

    return conversion.convert(
        ork,
        java_home=params.get("java_home"),
        jar_path=params.get("jar"),
        configuration=params.get("configuration"),
        fin_offsets=params.get("fin_offsets"),
    )


def _fly(params: dict) -> dict:
    """Fly converted parameters in RocketPy (S4)."""
    if not isinstance(params.get("parameters"), dict):
        raise ValueError("fly needs 'parameters' as returned by convert")

    sys.path.insert(0, str(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    from sidecar import flight

    return flight.fly(params["parameters"], overrides=params.get("overrides") or {})


def _flight_module():
    sys.path.insert(0, str(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    from sidecar import flight

    return flight


def _plot(params: dict) -> dict:
    return _flight_module().plots(params.get("kinds"))


def _eval(params: dict) -> dict:
    code = params.get("code")
    if not code or not str(code).strip():
        raise ValueError("eval needs 'code'")
    return _flight_module().evaluate(code)


METHODS = {
    "health": _health,
    "echo": lambda params: {"echo": params},
    "convert": _convert,
    "fly": _fly,
    "plot": _plot,
    "eval": _eval,
}


def handle_request(line: str) -> None:
    try:
        request = json.loads(line)
    except json.JSONDecodeError as exc:
        send({
            "id": None,
            "ok": False,
            "error": {"type": "BadJSON", "message": str(exc)},
        })
        return

    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}

    handler = METHODS.get(method)
    if handler is None:
        send({
            "id": request_id,
            "ok": False,
            "error": {
                "type": "UnknownMethod",
                "message": f"unknown method: {method!r}",
            },
        })
        return

    try:
        result = handler(params)
    except Exception as exc:  # report, never die
        traceback.print_exc(file=sys.stderr)
        send({
            "id": request_id,
            "ok": False,
            "error": {"type": type(exc).__name__, "message": str(exc)},
        })
        return

    send({"id": request_id, "ok": True, "result": result})


def main(argv: list[str]) -> int:
    send({
        "event": "ready",
        "protocol": PROTOCOL_VERSION,
        "engine": "rocketpy",
        "python": platform.python_version(),
        "rocketpy": _package_version("rocketpy"),
    })

    if "--selftest" in argv:
        send({"id": "selftest", "ok": True, "result": _health({})})
        return 0

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        handle_request(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
