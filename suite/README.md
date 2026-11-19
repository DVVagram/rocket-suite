# Rocket Suite

One application for rocket design, conversion, flight and analysis. It reuses
the established engines instead of re-implementing them:

| Concern | Engine | Licence |
| --- | --- | --- |
| Rocket design, `.ork` files, mass/CG/CP | OpenRocket 24.12 (in-process via JPype) | GPL-3.0 |
| Design → RocketPy conversion | RocketSerializer (uses ORHelper internally) | MIT |
| Flight physics | RocketPy | MIT |

Read [`docs/architecture.md`](../docs/architecture.md) for the integration
decisions, the ORHelper evaluation and the licensing analysis.

## Requirements

* Windows 10/11 (also runs on Linux/macOS), ~2 GB free disk.
* Python 3.12 — RocketPy's `netCDF4` dependency has no wheels for 3.14.
* A JRE 17 for OpenRocket 23+; the suite uses one JVM per session and no
  separate OpenRocket process.

Nothing needs administrator rights.

## Setup

```bash
# 1. Python 3.12 environment (uv is optional but fastest)
python -m uv venv --python 3.12 .venv
python -m uv pip install --python .venv/Scripts/python.exe -r suite/requirements.txt

# 2. JRE 17 + OpenRocket jar (downloads into tools/ and vendor/, git-ignored)
.venv/Scripts/python.exe suite/tools/setup_runtime.py
```

## Run

```bash
.venv/Scripts/python.exe suite/run.py
```

The suite opens on <http://127.0.0.1:8099/> (use `--port` to change it,
`--no-browser` when running headless).

## Layout

```
suite/
  backend/app.py          HTTP API + static hosting (one process)
  backend/config.py       runtime discovery: jar, JVM, examples
  backend/engines/jvm.py  the single JVM session
  backend/engines/convert.py   RocketSerializer conversion + loss report
  backend/engines/simulate.py  RocketPy flight via RocketSerializer's own builder
  backend/projects.py     .orsuite project files (design + conversion + results)
  frontend/               the SPA: dashboard, designer, simulator, viewer,
                          analysis, projects, settings
  tests/                  integration tests (pytest)
```

## Tests

```bash
.venv/Scripts/python.exe -m pytest suite/tests -q
```

The flight test runs the real pipeline and is skipped automatically when no
JRE or OpenRocket jar is available.

## Known limits (stage status)

* Reading designs, converting and flying them works end to end.
* Design **editing** (creating/modifying components and saving `.ork`) is the
  next stage; the Designer currently opens and inspects designs.
* RocketSerializer pairs the extracted motor with the design's stored
  OpenRocket flight results; for designs with several motor configurations the
  two can come from different configurations. The UI reports this rather than
  hiding it.
* `ejection` parachute deployment is mapped to RocketPy's apogee trigger and is
  listed as an approximation in the conversion report.
* Monte Carlo and STEP/STL import are not implemented yet.
