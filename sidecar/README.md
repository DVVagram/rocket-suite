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
| `convert` | `{"ork": "<path>", "java_home"?: "...", "jar"?: "..."}` | `parameters`, `reference`, `report`, `design` |
| `fly` | `{"parameters": <as returned by convert>, "overrides"?: {...}}` | `flight`, `events`, `conditions`, `report`, `seconds` |

## Conversion

`convert` runs RocketSerializer on a saved `.ork` and splits its output three ways:

| Key | Meaning |
| --- | --- |
| `parameters` | the converted design: the only thing a flight may read |
| `reference` | OpenRocket's own stored flight results: display and comparison only |
| `report` | `warnings`, `unsupported`, `approximations`, plus whether flight data was present |

The split is the separation contract in code: OpenRocket's results are removed
from the parameters before they are returned, so a flight cannot read them even
by accident.

Things it deliberately changes and reports:

* OpenRocket's `ejection` parachute trigger becomes RocketPy's `apogee` trigger,
  and the lost delay is listed under `approximations`;
* a parachute whose drag coefficient is `auto` gets `cd = 1.0`;
* pods, parallel boosters and wings are listed under `unsupported`.

### One configuration at a time

An `.ork` holds every configuration side by side, each with its own motor, and
each simulation belongs to one of them. RocketSerializer reads the motor from
one place and the stored flight from another, so on a multi-configuration design
it pairs a motor with a flight that was never flown with it: on the bundled
example it produced a C6 thrust curve (8.8 N·s) next to an A8 flight's apogee
(50.6 m).

The request therefore carries `"configuration": "<OpenRocket configuration id>"`
(the application sends the one selected in its window). `sidecar/ork_slice.py`
removes every other configuration, its motors and its simulations before the
converter sees the file, so geometry, motor and stored flight all come from the
same flight. Matching configurations gives agreement between the engines:

| Configuration | Impulse | OpenRocket | RocketPy |
| --- | --- | --- | --- |
| A8 | 2.32 N·s | 50.6 m | **50.1 m** (−1.0 %) |
| C6 | 8.81 N·s | 319.8 m | **319.9 m** (+0.1 %) |

An id that is no longer in the design is an error, not a silent fallback to
converting every configuration.

### OpenRocket 24.12 no longer writes the summary attributes

RocketSerializer reads `maxaltitude`, `maxvelocity` and friends from
`<simulation><flightdata ...>`; 24.12 writes `<flightdata>` empty and keeps the
per-branch data in `<databranch optimumAltitude=... types=...>` plus the point
table. So a file saved by this suite used to report a **0 m** reference. The
converter now recovers the comparison figures from the recorded points - still
OpenRocket's own flight, not a RocketPy result - and says in `report.warnings`
that it had to.

### The OpenRocket jar

RocketSerializer drives OpenRocket through `net.sf.openrocket.*` classes, the
package layout of OpenRocket 22/23. This suite forks 24.12, which renamed them
to `info.openrocket.core.*`, so a 24.12 jar **cannot** serve the converter. The
sidecar searches, in order: `"jar"` in the request, `ROCKETSUITE_ORK_JAR`, then
`vendor/openrocket/*.jar`, `.integration-src/RocketSerializer/*.jar`,
`tools/openrocket/*.jar` (highest version wins):

```bash
curl -L -o vendor/openrocket/OpenRocket-23.09.jar \
  https://github.com/openrocket/openrocket/releases/download/release-23.09/OpenRocket-23.09.jar
```

The JVM comes from `"java_home"`, `ROCKETSUITE_JAVA_HOME`, `JAVA_HOME`, a
`tools/*jre*` directory in the repository, or the OS. The application passes
its own `java.home`, so a working OpenRocket is enough of a JVM.

## Flight

`fly` builds RocketPy objects from `parameters` alone and runs the flight:
`Environment` (standard atmosphere), `SolidMotor` (from the converted thrust
curve and grain data), `Rocket` (mass, inertia, centre of mass, drag curve),
nose cone, trapezoidal fins and parachutes, then `Flight` with OpenRocket's rail
length, inclination and heading.

It never imports OpenRocket, JPype or RocketSerializer, and a test asserts that:
the flight cannot read OpenRocket's stored results even by accident. The
parameters dictionary it receives has already had `stored_results` removed.

What the flight reports rather than hides, in `report.approximations`:

* **still air** - OpenRocket's average wind is not applied, so the two flights
  are not conflated;
* **one drag curve** - OpenRocket's whole-flight drag is used for powered and
  unpowered flight alike;
* **motor** - flown as a solid motor with the grain geometry OpenRocket reports.

Unsupported geometry (elliptical fins, wings, pods) is listed in
`report.unsupported` and is not in the flight.

### Flight data must be in the file

OpenRocket saves only simulation summaries by default, but RocketSerializer
derives mass and aerodynamic properties from the sampled points. The Java side
saves its own temporary copy with `saveSimulationData` forced on, so the file
that crosses always has data regardless of the user's save settings. A design
with no stored simulation at all is reported as a warning and converted anyway.

## Running it by hand

```bash
.venv/Scripts/python.exe sidecar/rocketpy_sidecar.py            # serve on stdin/stdout
.venv/Scripts/python.exe sidecar/rocketpy_sidecar.py --selftest # ready + health, then exit
python -m pytest sidecar/tests -q                               # protocol + conversion tests
```
