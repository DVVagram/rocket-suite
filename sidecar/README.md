# RocketPy sidecar

A separate process that runs RocketPy for the Rocket Suite. It exists so the
flight engine never shares a heap with OpenRocket, and so the JVM can be absent
from this process entirely (S8 will remove the JPype bridge that S3 uses for
conversion).

## Protocol

Newline-delimited JSON, one frame per line, UTF-8.

**Unsolicited, on start-up:**

```json
{"event": "ready", "protocol": 1, "engine": "rocketpy", "python": "3.12.16", "rocketpy": "1.13.0"}
```

**Request / response:**

```json
{"id": "1", "method": "health", "params": {}}
{"id": "1", "ok": true,  "result": { ... }}
{"id": "1", "ok": false, "error": {"type": "UnknownMethod", "message": "..."}}
```

* `id` is chosen by the caller and echoed back; frames may be answered out of order.
* A malformed request is answered with `"id": null` and `ok: false`; the
  process keeps running.
* Any other output — warnings, library prints, Java output from JPype — goes to
  **stderr**, because stdout is reserved for frames. The process redirects fd 1
  to fd 2 at start-up for exactly this reason: JPype writes through the file
  descriptor and would otherwise interleave with frames.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `health` | — | protocol, engine, python, platform, rocketpy/rocketserializer versions |
| `echo` | anything | `{"echo": <params>}` |

`convert` and `fly` arrive in S3 and S4.

## Running it by hand

```bash
.venv/Scripts/python.exe sidecar/rocketpy_sidecar.py            # serve on stdin/stdout
.venv/Scripts/python.exe sidecar/rocketpy_sidecar.py --selftest # ready + health, then exit
python -m pytest sidecar/tests -q                               # protocol tests
```
