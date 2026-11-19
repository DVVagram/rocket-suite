# Unified Rocket Suite — integration architecture

Status: **Stage 1 (inspection and architecture)** plus the first working vertical
slice. Written after inspecting the four upstream repositories at the commits
recorded below and probing this machine's toolchain.

## 0. Starting point, and one correction

The repository's `main` branch does **not** contain a TVC application. It
contains the OpenRocket 24.12 source tree plus the standalone
`visual-simulation/` module added earlier.

So "replace the TVC application" is interpreted as:

* `main` is preserved untouched as the baseline that holds the earlier work.
* The suite is built on `unified-rocket-suite`, and in it the standalone
  visual-simulation page is superseded by the integrated application (the old
  module stays on disk and in history; nothing is destroyed).

This document records what the upstream projects actually are, what is reused,
what is intentionally *not* reused, and where the integration pays runtime cost.

## 1. Inventory (inspected, not assumed)

| Project | Version inspected | Licence | Language | Size (working tree) | Role |
| --- | --- | --- | --- | --- | --- |
| OpenRocket | 24.12 (`release-24.12` in this repo) | **GPL-3.0** | Java 17, Gradle | ~98 MB | Authoritative design model, component geometry, mass/CG/CP, `.ork` I/O |
| RocketPy | 1.13.0 | **MIT** | Python ≥3.10 | 384 MB incl. docs/tests | 6-DOF flight physics, motors, atmosphere, wind, events |
| RocketSerializer | 0.2.0 | **MIT** | Python | 84 MB (incl. 139 MB of jars) | `.ork` → RocketPy parameters (`ork2json`) |
| ORHelper | 0.2.1 | **GPL-2.0-only** | Python (JPype) | 1.2 MB | Runs OpenRocket classes inside a JVM from Python |
| or-monte-carlo | HEAD | **no licence file** | Java (Gradle plugin) | 638 KB | Monte Carlo extension for OpenRocket |

Dependency facts that shaped the design:

* RocketPy pulls `numpy`, `scipy`, `matplotlib`, `netCDF4`, `requests`, `pytz`,
  `simplekml`, `dill`. It declares support for Python ≥3.10; Python 3.14 wheels
  for `netCDF4` are not reliably published, so the suite pins **Python 3.12**.
* RocketSerializer's `requirements.in` is
  `bs4, click, lxml, numpy, jpype1<1.5, pyyaml, rocketpy, nbformat, orhelper`.
  Its runtime module (`rocketserializer/openrocket_runtime.py`) imports `jpype`
  **and** `orhelper` and loads an `OpenRocket-*.jar`.
* The clones ship `OpenRocket-22.02.jar` and `OpenRocket-23.09.jar` (69–70 MB
  each). OpenRocket ≥ 23 requires Java 17; older jars need Java 8.
* ORHelper exposes OpenRocket through JPype (`orhelper.OpenRocketInstance`,
  helpers for simulations and component data) and therefore needs a JVM.

## 2. Overlap analysis and the ORHelper decision

ORHelper is **not optional in practice**: RocketSerializer imports it. Dropping
ORHelper would mean forking RocketSerializer, which contradicts "reuse the
actual conversion implementation".

Decision:

1. **RocketSerializer is the single conversion bridge.** It is what turns a
   design into RocketPy inputs, and it keeps the conversion auditable
   (`parameters.json`, conversion warnings).
2. **ORHelper is used only transitively, through RocketSerializer.** No second,
   parallel ORHelper extraction path is created, so there is exactly one source
   of truth for "read the design for simulation".
3. A **direct JPype–OpenRocket link** is added for the one capability
   RocketSerializer does not provide: *editing and saving* `.ork` files
   (OpenRocket's `OrkReader`, component APIs, `OpenRocketSaver`). This is not a
   duplicate retrieval path — it is the design editor. Both paths share **one**
   JVM instance manager, so there is only ever one JVM in the process.
4. ORHelper is **not** used for simulation: RocketPy is the flight engine, so
   OpenRocket's own simulator would be a second physics implementation of the
   same flight.

Measured cost of that shared JVM is reported in §7; if the JVM turns out to
dominate startup, the design already allows the JVM to be started lazily and
only for design/conversion work.

## 3. Runtime architecture

```
                     one Python process (uvicorn / FastAPI)
  ┌──────────────────────────────────────────────────────────────────────┐
  │  suite/backend/app.py            HTTP + static SPA hosting           │
  │                                                                      │
  │  engines/jvm.py         single lazily-started JVM (JPype)            │
  │      ├── engines/design.py    OpenRocket load / edit / save (.ork)   │
  │      └── engines/convert.py   RocketSerializer extraction + report   │
  │  engines/simulate.py    RocketPy flight (imported on first use)      │
  │  engines/geometry.py    component tree → mesh JSON for the viewer    │
  │  projects.py            .orsuite project files (design + results)    │
  └──────────────────────────────────────────────────────────────────────┘
                     ▲ fetch/JSON
  ┌──────────────────┴───────────────────────────────────────────────────┐
  │  suite/frontend/  static SPA: Dashboard, Designer, Simulator,        │
  │                   3D Viewer, Analysis, Projects, Settings            │
  │                   three.js (vendored), charts drawn on canvas 2D     │
  └──────────────────────────────────────────────────────────────────────┘
```

Why this shape:

* **One process, one JVM, no extra services.** No Electron, no second backend,
  no OpenRocket GUI process, no FreeCAD, no message queue.
* **Engines are import-isolated.** `rocketpy` (and matplotlib/netCDF4 behind
  it) is imported only when a simulation runs or a plot is requested;
  the JVM starts only when a design or conversion operation needs it.
* **Projects are files**, not a database: a `.orsuite` file is JSON holding the
  original `.ork` design text verbatim, the converted parameters, the
  simulation settings and the results, with provenance flags so original,
  converted, calculated and approximated values never overwrite each other.
* **The 3D viewer animates RocketPy samples.** It never integrates physics of
  its own.

## 4. Data flow (the required workflow)

1. Design opened/edited in the Designer → OpenRocket (JVM) returns the
   component tree, mass, CG, CP, stability.
2. Project saved → the `.ork` XML is stored **unchanged** in the project file.
3. User starts a flight → `convert` calls RocketSerializer on the `.ork` and
   returns `parameters.json` plus a conversion report (unsupported components,
   approximations, errors). Nothing is silently dropped.
4. `simulate` builds the RocketPy environment/rocket/motor from those
   parameters and runs the flight.
5. Results (time series, events, apogee, max velocity/acceleration, stability)
   return to the app, are shown in Analysis and animated in Viewer.
6. Saving again stores design + converted data + results, flagged by origin.

## 5. Licensing consequences (important)

* OpenRocket is **GPL-3.0**. Any distribution of a combined work that contains
  it must be GPL-3.0 with source availability. The suite is therefore
  distributed under **GPL-3.0**, keeps OpenRocket's `LICENSE.TXT` and headers
  intact, and keeps upstream code in identifiable directories
  (`.integration-src/` is a local scratch clone and is **not** redistributed;
  the redistributed OpenRocket tree is the one at the repository root).
* ORHelper is **GPL-2.0-only**, which is *incompatible* with GPL-3.0 for a
  single combined distribution. This is inherited from RocketSerializer's
  dependency choice, not introduced here.
  * Practical position: the suite does not ship the JVM bridge as a single
    linked binary; OpenRocket and ORHelper remain separate, unmodified
    components invoked through JPype, and the whole distribution is GPL-3.0
    with complete sources.
  * If a strictly clean GPL-3-only distribution is required later, the
    converter can be pointed at a JPype-direct extractor written against
    OpenRocket's public API (GPL-3.0 → GPL-3.0) and ORHelper dropped. The
    conversion module is deliberately isolated behind one interface so that
    swap is local.
* RocketPy and RocketSerializer are MIT; their notices are preserved.
* `or-monte-carlo` has **no licence file**, so its code cannot be reused. The
  Monte Carlo feature is therefore implemented locally as a thin driver over
  RocketPy (which is MIT), and stays optional.

## 6. What is deliberately not done

* No FreeCAD integration, no STEP→mesh pipeline yet (STL preview only is
  planned behind a feature flag); the viewer stays a mesh viewer.
* No embedded OpenRocket Swing GUI — the design editor is a native part of the
  suite driven by OpenRocket's model classes.
* No second flight engine, no re-implementation of Barrowman/MassCalculator in
  the suite (the earlier JavaScript port stays only in the legacy
  `visual-simulation/` module and is not imported by the suite).
* No persistent daemons; no background JVM when the app is idle beyond the
  single session JVM.

## 7. Measured environment cost

Provisioned on this machine without administrator rights:

| Item | Size | Notes |
| --- | --- | --- |
| Python 3.12.16 (uv-managed) | 27 MB | `uv python install 3.12` |
| `.venv` with rocketpy + rocketserializer + orhelper + jpype | see report | installed with `uv pip` |
| Temurin JRE 17 (`tools/jdk-17.0.21+9-jre`) | 44 MB download, ~120 MB unpacked | only needed for design/conversion |
| OpenRocket jar used by the bridge | 69 MB | `OpenRocket-23.09.jar` from RocketSerializer |

Startup/memory measurements with and without the JVM are produced by
`suite/tests/test_performance.py`; results are appended to
`docs/measurements.md`.

## 8. Stages and their acceptance tests

| Stage | Delivered | Test |
| --- | --- | --- |
| 1 | this document, branch, inventory | reviewed |
| 2 | suite skeleton + SPA shell + config | `GET /api/health`, SPA loads |
| 3 | OpenRocket design open/save | round-trip a bundled `.ork`, compare CG/CP |
| 4 | RocketSerializer conversion | convert 5 bundled designs, record warnings |
| 5 | ORHelper evaluation | §2 decision + measured JVM cost |
| 6 | RocketPy simulation | fly the converted design, compare apogee |
| 7 | project files + auto-conversion | save/reopen, values preserved |
| 8 | 3D viewer | animate real samples |
| 9 | analysis | plots from real series |
| 10 | optional Monte Carlo / weather | optional module, off by default |
| 11 | UI polish | — |
| 12 | integration tests + perf | `pytest` green, measurements recorded |

Stages are landed as separate commits; each commit leaves the app runnable.
