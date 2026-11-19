"""Single JVM shared by every engine.

The suite never starts an OpenRocket process and never opens a second JVM:
RocketSerializer's own session driver is reused, with the OpenRocket jar it
already knows how to load.  Java logging is turned off so the debug output of
OpenRocket's preset loader does not flood the host application.
"""

from __future__ import annotations

import threading
from pathlib import Path

from .. import config

_lock = threading.Lock()
_session = None


def open_session():
    """Return a started RocketSerializer OpenRocketSession (one per process)."""
    global _session
    with _lock:
        if _session is not None:
            return _session

        config.configure_java()
        jar = config.find_jar()
        if jar is None:
            raise RuntimeError(
                "No OpenRocket jar found. Put one in vendor/openrocket/ or set ORK_JAR."
            )

        session = _start(jar)
        _session = session
        return _session


class _OrhelperSession:
    """Adapter for RocketSerializer releases that talk to ORHelper directly."""

    def __init__(self, instance, helper) -> None:
        self._instance = instance
        self._helper = helper

    def load_doc(self, path: str):
        return self._helper.load_doc(str(path))

    def __exit__(self, *exc) -> None:
        self._instance.__exit__(*exc)


def _start(jar: Path):
    """Start the JVM through RocketSerializer's own OpenRocket driver."""
    try:
        from rocketserializer.openrocket_runtime import OpenRocketSession
    except ImportError:
        # Older RocketSerializer wheels drive ORHelper directly.
        import orhelper

        instance = orhelper.OpenRocketInstance(str(jar), log_level="OFF")
        instance.__enter__()
        return _OrhelperSession(instance, orhelper.Helper(instance))

    session = OpenRocketSession(jar, log_level="OFF")
    session.__enter__()
    return session


def close_session() -> None:
    global _session
    with _lock:
        if _session is not None:
            try:
                _session.__exit__(None, None, None)
            finally:
                _session = None


def jar_path() -> Path:
    jar = config.find_jar()
    if jar is None:
        raise RuntimeError("No OpenRocket jar found")
    return jar
