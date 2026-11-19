"""Protocol tests for the RocketPy sidecar.

They spawn the sidecar as a real subprocess and talk to it exactly as the Java
client does, so framing bugs and stdout pollution are caught here rather than in
the desktop app.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SIDECAR = Path(__file__).resolve().parents[1] / "rocketpy_sidecar.py"


class Sidecar:
    def __init__(self) -> None:
        self.process = subprocess.Popen(
            [sys.executable, str(SIDECAR)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.ready: dict = {}

    def read(self) -> dict:
        assert self.process.stdout is not None
        line = self.process.stdout.readline()
        assert line, f"sidecar closed the stream; stderr={self.stderr()}"
        return json.loads(line)

    def send_raw(self, text: str) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(text + "\n")
        self.process.stdin.flush()

    def request(self, method: str, params: dict | None = None, request_id: str = "1") -> dict:
        self.send_raw(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        return self.read()

    def stderr(self) -> str:
        if self.process.poll() is None:
            return "<still running>"
        return (self.process.stderr.read() if self.process.stderr else "")[-800:]

    def close(self) -> int:
        assert self.process.stdin is not None
        self.process.stdin.close()
        return self.process.wait(timeout=15)


@pytest.fixture()
def sidecar():
    client = Sidecar()
    client.ready = client.read()
    yield client
    client.close()


def test_startup_announces_engine(sidecar):
    assert sidecar.ready["event"] == "ready"
    assert sidecar.ready["engine"] == "rocketpy"
    assert sidecar.ready["protocol"] == 1
    assert sidecar.ready["python"].startswith("3.")


def test_health_reports_versions(sidecar):
    response = sidecar.request("health", request_id="abc")
    assert response["ok"] is True
    assert response["id"] == "abc"
    result = response["result"]
    for key in ("python", "platform", "executable"):
        assert result[key], f"{key} must be reported"
    assert result["rocketpy"], "RocketPy must be importable in the sidecar environment"


def test_utf8_survives_the_stream(sidecar):
    assert sidecar.request("health")["result"]["mu_symbol"] == "\u00b5"


def test_unknown_method_is_reported_and_process_survives(sidecar):
    response = sidecar.request("does-not-exist", request_id="7")
    assert response["ok"] is False
    assert response["id"] == "7"
    assert response["error"]["type"] == "UnknownMethod"
    assert sidecar.request("echo", {"a": 1})["ok"] is True


def test_malformed_frame_does_not_kill_the_sidecar(sidecar):
    sidecar.send_raw("{not json")
    error = sidecar.read()
    assert error["ok"] is False
    assert error["id"] is None
    assert error["error"]["type"] == "BadJSON"
    assert sidecar.request("echo", {"still": "alive"})["result"] == {"echo": {"still": "alive"}}


def test_echo_round_trips_nested_payload(sidecar):
    payload = {"numbers": [1, 2.5, -3], "text": "nose cone", "flag": True, "nothing": None}
    assert sidecar.request("echo", payload)["result"]["echo"] == payload


def test_sidecar_exits_cleanly_on_eof():
    client = Sidecar()
    client.read()
    assert client.close() == 0
