# Rocket Suite — build plan

A desktop application that is **OpenRocket, with one extra tab**: design the
rocket in OpenRocket's own UI, switch to the RocketPy tab, fly it there. Both
engines stay in their current forms; RocketPy's calculations stay strictly
separate from OpenRocket's.

This repository was cleared to start from that premise. The previous web
implementation and the imported OpenRocket tree remain in git history
(`unified-rocket-suite` and `main`), not on disk.

---

## 1. Verified facts the plan rests on

Re-examined on 2026-11-19 from the source trees and installed packages.

**OpenRocket 24.12** — Java 17, Gradle **8.12.1** wrapper, modules `:core` and
`:swing`, `application` plugin with
`mainClass = info.openrocket.swing.startup.OpenRocket` (`build.gradle:15–17`).

Its main window is already a tab container —
`swing/src/main/java/info/openrocket/swing/gui/main/BasicFrame.java`:

```java
public class BasicFrame extends JFrame {            // line 124
    public BasicFrame(OpenRocketDocument document)   // line 188
    tabbedPane = new JTabbedPane();                  // line 224
    tabbedPane.addTab("Rocket design",       null, designPanel);
    tabbedPane.addTab("Flight configuration", null, flightConfigurationPanel);
    tabbedPane.addTab("Flight simulation",   null, simulationPanel);
```

So the target is a **fourth tab in OpenRocket's own frame**. Nothing of
OpenRocket's UI is rewritten, and its model, calculators, 3-D view, simulation
and file handling all stay as they are.

**RocketPy 1.13.0** — a Python library with **no GUI**: the installed package is
`environment/`, `motors/`, `rocket/`, `simulation/`, `plots/`, `prints/`,
`control/`, `stochastic/`, `sensitivity/`, `sensors/`, `mathutils/`. Public API
includes `Environment`, `SolidMotor`/`HybridMotor`/`LiquidMotor`, `Rocket`,
`Flight`, `Compare`/`CompareFlights`, `AirBrakes`, sensor models. Drag is a
**required input** (`power_off_drag`: number, callable, file or array) — there
is no auto-derive mode, which is why OpenRocket's drag curve crosses the
boundary as design data.

**RocketSerializer 0.2.0** — Python, entry points `ork2json` / `ork2notebook`,
requires `orhelper==0.1.3` + `jpype1` + an OpenRocket jar, and **refuses designs
with no stored OpenRocket simulation data**. Its converter is the fastest route
from the open design to RocketPy parameters.

**ORHelper 0.1.3** — the JPype bridge RocketSerializer depends on; used only
transitively, never as a second retrieval path.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ OpenRocket (Java 17, GPL-3.0) — one JVM, its own window          │
│ [Rocket design][Flight configuration][Flight simulation][RocketPy]│
│                        │ live OpenRocketDocument                  │
│                        ▼                                         │
│              bridge (design → parameters → JSON)                 │
└────────────────────────┬─────────────────────────────────────────┘
                         │ stdin/stdout JSON — no sockets, no HTTP,
                         │ no browser, no second window
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ Python sidecar — RocketPy only                                   │
│ run flight → summary, events, series, RocketPy's own plots (PNG) │
└──────────────────────────────────────────────────────────────────┘
```

Two bridge variants, B1 first and B2 later:

| | How the design reaches RocketPy | JVMs | Trade-off |
| --- | --- | --- | --- |
| **B1** | Sidecar runs RocketSerializer on the saved `.ork` | 2 | smallest amount of new code; +150–200 MB, ~8–10 s first convert |
| **B2** | Java exporter calls OpenRocket's own calculators on the live document, writes `parameters.json` | 1 | ~1–2k lines of marshalling; removes jpype/orhelper/jar from the Python bundle |

B2 is also the structural guarantee of separation: a sidecar with no JVM and no
OpenRocket classes physically cannot use OpenRocket's calculations.

### Separation contract (binding)

* **OpenRocket owns** geometry, mass, CG, inertia, CP, stability, thrust and
  drag curves. **RocketPy owns** atmosphere, gravity, forces, integration,
  events, apogee. No quantity is computed by both or blended.
* Crossing the boundary, one way and as **design inputs only**: geometry for
  aerodynamic surfaces, mass, CG, inertia, thrust curve, drag curve, launch
  conditions. Units converted explicitly and logged.
* Never crossing: OpenRocket's simulated flight results as anything RocketPy
  reads; RocketPy output written back into `.ork` or design values; shared
  caches; averaged "final" numbers.
* OpenRocket's stored results live in a **display-only `reference`** structure
  that flight code cannot read. Every displayed number carries its engine label.
* Enforced by test: the flight module must import and run with `jpype` and
  `orhelper` blocked.

---

## 3. Stages

Each stage ends with the app running and its own acceptance test; none is a
big-bang change. "Verified" means observed output, not intent.

| # | Stage | Deliverable | Acceptance |
| --- | --- | --- | --- |
| **S0** | Build the unmodified baseline | JDK 17 + Gradle 8.12.1 build of OpenRocket 24.12 from source; launcher documented | `gradlew :swing:run` opens OpenRocket; baseline startup time and memory recorded |
| **S1** | Fourth tab, empty | `RocketPy` tab added in `BasicFrame`; no other behaviour touched | All existing tabs, menus, file open/save, 3-D and simulation work exactly as in S0 |
| **S2** | Sidecar skeleton | Python process, JSON protocol over stdin/stdout, health handshake, timeouts, crash reporting | Fake request round-trips; sidecar death is reported in the tab, OpenRocket keeps running |
| **S3** | Bridge B1 | Save active document → RocketSerializer → parameters; conversion report (unsupported/approximations) shown in the tab | 5 bundled example designs convert; every conversion loss listed, none hidden |
| **S4** | Flight | RocketPy runs from the parameters; tab shows summary, events, and RocketPy's own output | Series share one time base; repeated runs agree; flight time recorded |
| **S5** | Separation + correctness | `reference` split from inputs; import-blocking test; **configuration-selection fix** (motor config vs stored flight) | Separation tests pass; apogee deltas explained per run, not by 600 % |
| **S6** | Full RocketPy reach | Advanced/console pane with the converted objects pre-bound; RocketPy plots as images; `Compare` for two runs | Anything RocketPy can do is reachable without editing our code |
| **S7** | Packaging | jlink JRE (≈50–65 MB), embedded Python, jar, installer | Runs on a clean Windows machine with no Python, Java or Qt installed; startup and memory measured |
| **S8** | Optional B2 | Java exporter using OpenRocket's calculators; drop jpype/orhelper/jar from the sidecar | Same results within a documented tolerance; one JVM; faster first conversion |

Deliberately **not** built: a new designer, a web shell, a custom 3-D viewer, a
custom plotting library, FreeCAD integration.

### Progress

| Stage | State | Evidence |
| --- | --- | --- |
| S0 | **done** | `swing-24.12-all.jar` (83 MB) builds from `release-24.12` (133b558) with Gradle 8.12.1 + JDK 17; the window opens in 11.5 s and the JVM settles at 542–677 MB |
| S1 | **done** | `RocketPyTabTest` passes: 4 tabs, the 4th is `RocketPyPanel`, OpenRocket's three tabs unchanged; the rebuilt app still launches (18.7 s cold) |
| S2 | **done** | sidecar protocol (7 pytest cases) and `SidecarClient` (5 JUnit cases, 0 skipped) pass against the real Python process, including a killed-process case that must raise rather than hang; the app still builds and launches (18.7 s, 597 MB) |
| S3 | **done** | the open document is saved by OpenRocket's own saver (with flight data forced on) and converted by RocketSerializer in the sidecar: 5 bundled examples convert (0.061–11.08 kg), every loss listed — ARC's `lowerstageseparation` parachute trigger is reported rather than dropped; 13 pytest cases and `DesignConversionTest` (save → reload, save → convert, 0 skipped) pass; the app still launches (no exceptions) |
| S4 | **done** | `fly` builds Environment/Motor/Rocket/nose/fins/parachutes from the parameters only and flies: apogee **319.9 m at 7.8 s**, max speed 94.7 m/s (Mach 0.279), off the rail 17.3 m/s, flight time 93.5 s, 7.3 s of wall time; 19 pytest cases (6 of them flight) and 9 JUnit cases pass |
| S5 | **done** | the selected configuration is sliced out before conversion, so motor, geometry and stored flight come from the same flight: A8 → OpenRocket 50.6 m / RocketPy **50.1 m (−1.0 %)**, C6 → 319.8 m / **319.9 m (+0.1 %)**; the reference is recovered from the recorded points because 24.12 stopped writing the summary attributes; 23 pytest and 9 JUnit cases pass |
| S6 | **done** | RocketPy's own plots are rendered to PNG and shown in the tab (trajectory 3D, kinematics, aero forces, energy, pressure), the console runs real Python against the same `environment`/`motor`/`rocket`/`flight` (`print(flight.apogee)` → 319.9), and each run is compared with the previous one and with OpenRocket's stored flight; 26 pytest and 9 JUnit cases pass |
| S7 | **done** | `dist\RocketSuite` is 554 MB - linked JRE 55 MB, CPython 63 MB, RocketPy stack 340 MB, jar 80 MB - and is also `RocketSuite-portable.zip` (297 MB) and `RocketSuite-Setup.exe` (297 MB), both built by `packaging/windows/`; started from the bundle, the window opens in **9.2 s / 10.7 s** at 594-606 MB RSS, the sidecar reports rocketpy 1.13.0, and a convert + fly on the bundled stack gives **319.9 m**; the installer was run here: files land in `%LOCALAPPDATA%\Programs\RocketSuite`, Start menu and desktop shortcuts, an uninstall entry, and the app starts from it |

Build and run (from the repository root, JDK 17 in `tools/`):

```bash
./gradlew :swing:shadowJar          # produces swing/build/libs/swing-24.12-all.jar
java -cp swing/build/libs/swing-24.12-all.jar info.openrocket.swing.startup.OpenRocket
./gradlew :swing:test --tests "info.openrocket.swing.gui.main.RocketPyTabTest"
.venv/Scripts/python.exe -m pytest sidecar/tests -q   # protocol + conversion (needs the 23.09 jar)
```

The component/motor database is the upstream submodule
`core/resources-src/datafiles/openrocket-database`; without it the app starts but
has no motors or presets.

---

## 4. Risks

### What S4 measured, and what it exposed

Flying the same example gives numbers that **disagree with OpenRocket's stored
flight**: RocketPy says 319.9 m apogee and 94.7 m/s; the stored results say
50.6 m and 29.2 m/s. The thrust curve in the file has a total impulse of
8.8 N·s (a C6-class motor), which cannot produce 50 m apogee in a 61 g rocket,
so the stored flight does not describe the motor in the design. This is the
known S5 defect - RocketSerializer pairs a converted motor with another
configuration's stored flight - now visible in the product, and it is why the
panel labels OpenRocket's numbers "reference only" and says so explicitly.

RocketPy's own static margin from the converted geometry (8.5 cal) also differed
from OpenRocket's 3.2 cal.

**Partly fixed after S7.** The figure the tab showed was the *largest* margin
anywhere in the flight - reached after burnout, when the propellant is gone -
rather than the margin at ignition. It reports the launch value now, with the
maximum kept beside it. That alone explains 8.46 against 7.59 for the example.

The fin positions are a separate question, and the answer so far is that they are
not ours to recompute. Reading them out of the design's component tree fixed the
example (fins at 0.281 m, inside its 0.332 m airframe, instead of 0.508 m behind
the tail) but broke other designs, because OpenRocket positions components against
the front, middle or back of a *stage*, and a stage's length is not written in the
file - only derivable, sometimes circularly. Measured against OpenRocket's own
recorded centre of pressure over eleven bundled designs, the reconstruction was
worse than RocketSerializer's positions (mean error 0.35 m against 0.24 m) and
wrong by up to 1 m on multi-stage designs. So it was withdrawn rather than
shipped: the converter's fin positions are used unchanged.

**Also measured while checking the above, not fixed:** one bundled example, `Pods--powered with recovery deployment.ork`, fails inside RocketSerializer with `list index out of range`. Our side of the bridge turns that into a clear conversion error that the tab shows; nothing is swallowed and no design half-converts.

What that leaves, all of it visible in the product. The converter's fin
positions still put the example's fins 0.227 m past its tail, so its converted
centre of pressure is 0.452 m against OpenRocket's 0.300 m and its static margin
reads 7.59 cal against OpenRocket's 2.1 - it looks more stable than it is.
RocketPy also has no surface for a body tube, so it takes lift from the nose and
the fins only. Both limits are stated in every flight report (`report.unsupported`)
rather than hidden, and both are open. Apogee is unaffected: 319.9 m against
OpenRocket's 319.8 m.

`test_static_margin_is_the_figure_at_launch` holds the launch-versus-maximum
distinction down, and `test_flight_reports_its_assumptions` checks that the
body-tube limit is stated. The fin-position assertions went with the override
they tested.

Two more defects surfaced while testing the packaged build. `SwingPreferences`
resolved its node name in a static initialiser, so the property a test sets
arrived too late whenever another test class had already loaded the class - the
isolation only worked by luck of ordering; the name is now read on every use.
And `Icons.getScaledIcon` threw a `NullPointerException` on the empty icons that
OpenRocket's own test mode produces, which made the tab test fail depending on
which class ran first; it now returns the icon unscaled. The full suite is green:
27 pytest cases and 36 JUnit cases.

**Resolved in S5.** The mismatch was not a physics error: RocketSerializer read
the thrust curve from the last simulation in the file and the stored summary
from the first, so it compared a C6 burn against an A8 flight. Converting one
configuration at a time - the one selected in OpenRocket - makes the two engines
agree to within 1 %: 50.1 m against 50.6 m for the A8 configuration, 319.9 m
against 319.8 m for the C6. A second, independent defect surfaced on the way:
OpenRocket 24.12 writes `<flightdata>` without the attributes RocketSerializer
needs, so every design saved by this app reported a 0 m reference; the figures
are now recovered from the recorded flight points. The static-margin difference
is the remaining open item, and it no longer affects the apogee comparison.

| Risk | Mitigation |
| --- | --- |
| B1 needs an **OpenRocket 22/23 jar** next to the 24.12 app, because RocketSerializer uses the pre-rename `net.sf.openrocket.*` packages | documented and searched for (`vendor/openrocket`, `ROCKETSUITE_ORK_JAR`); S8/B2 removes the need entirely |
| OpenRocket stores only simulation **summaries** by default, which the converter cannot use | the exported copy forces `saveSimulationData`; a design with no simulation is reported, not silently flown |
| Tests that install `SwingPreferences` write to the real user preferences, which changed what the application showed on the next start | fixed: `SwingPreferences` now takes its node name from `-Dopenrocket.preferences.node`, and the tests set it to `OpenRocket-tests` (a test asserts the node in use). Redirecting `java.util.prefs.userRoot` was tried first and does nothing on Windows, where preferences are registry-backed |
| The app is a **fork of OpenRocket** | keep the diff small and isolated (one tab + one bridge class); rebase onto upstream releases; GPL-3.0 with sources (accepted) |
| Second JVM in B1 | acceptable at first; B2 removes it; the memory cost is measured, not guessed |
| RocketSerializer needs a design that has been simulated in OpenRocket | the simulation tab is right beside the RocketPy tab; the tab states the requirement and offers to run it |
| Drag input coupling | OpenRocket's drag curve is labelled as design data; a constant-Cd alternative is selectable |
| RocketPy plots are matplotlib images in a Swing tab | PNG first; data export available; interactive plotting only if it proves necessary |
| RocketPy models lift from the nose and fins only - no body tube - and takes the converter's fin positions as given, so its centre of pressure and static margin can differ from OpenRocket's | both facts are stated in the flight report on every run; the numbers measured across eleven designs are above, and recomputing the fin positions from the design file was tried and withdrawn |
| Two runtimes to ship | jlink JRE + embedded CPython, measured in S7 |

## 5. Repository state

Cleared on branch `desktop-fork`. Kept out of git but on disk: `.integration-src/`
(reference clones of RocketPy, RocketSerializer, ORHelper, or-monte-carlo),
`.venv/` (Python 3.12 + RocketPy stack) and `tools/` (portable JRE 17).

The converter's OpenRocket 23.09 jar lives in `.integration-src/RocketSerializer/`
on this machine; `vendor/openrocket/` is the git-ignored place for it in a fresh
checkout (see `sidecar/README.md`).
