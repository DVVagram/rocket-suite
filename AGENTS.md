# Working in this repository

This is **OpenRocket 24.12 plus one tab**. Design the rocket in OpenRocket's own
tabs, then fly the same design in RocketPy on the fourth tab. Upstream OpenRocket
code is not to be rewritten: the diff is one tab (`swing/.../gui/rocketpy/`) plus
the Python sidecar (`sidecar/`).

`PLAN.md` is the record of what is been measured and what is still open. Read it
before changing anything numeric; it carries the numbers this project argues from.

## The separation contract (binding)

* **OpenRocket owns** geometry, mass, CG, inertia, CP, stability, thrust and drag
  curves. **RocketPy owns** atmosphere, gravity, forces, integration, events,
  apogee. Nothing is computed by both or blended.
* Only design inputs cross, one way. OpenRocket's simulated flight goes over as a
  display-only `reference` that flight code cannot read.
* `sidecar/flight.py` must not import `jpype`, `orhelper`, `rocketserializer` or
  anything under `net.sf.openrocket`. A test enforces this; do not relax it.

## Build, run, test

```bash
export JAVA_HOME="$PWD/tools/jdk-17.0.21+9"; export PATH="$JAVA_HOME/bin:$PATH"

./gradlew --no-daemon --console=plain :swing:test          # 36 JUnit cases
./gradlew --no-daemon --console=plain :swing:shadowJar -x test
java -cp swing/build/libs/swing-24.12-all.jar info.openrocket.swing.startup.OpenRocket

./.venv/Scripts/python.exe -m pytest sidecar/tests -q      # 27 cases, Windows path
```

* The motor/preset database is a submodule:
  `git submodule update --init --recursive`.
* Conversion needs an OpenRocket **22/23** jar (24.12 renamed the packages the
  converter uses). It is at `.integration-src/RocketSerializer/OpenRocket-23.09.jar`
  on the development machine; fetch it with
  `curl -L -o .integration-src/RocketSerializer/OpenRocket-23.09.jar https://github.com/openrocket/openrocket/releases/download/release-23.09/OpenRocket-23.09.jar`.
* Python 3.12 in `.venv` with rocketpy 1.13.0, rocketserializer 0.2.0, jpype 1.7.1.

## Traps that have already cost time

* **A JVM started inside pytest faults on Windows.** Runtime tests must launch a
  subprocess (`python -c ...`) and pass `stderr=subprocess.DEVNULL`.
* **MSYS mangles arguments**: `MSYS2_ARG_CONV_EXCL="*"` for `java`/`cmd`, and
  `cmd //c "C:\path\x.cmd"` for batch files. `tar` here is GNU tar and cannot
  write a zip.
* **Preferences**: tests set `-Dopenrocket.preferences.node=OpenRocket-tests`;
  `SwingPreferences` reads that on every use, not in a static initialiser.
* **Fin positions** come from RocketSerializer and are *not* recomputed from the
  `.ork`. That was tried and withdrawn - see PLAN.md for the eleven-design
  measurement. Do not "fix" it by re-deriving stage-relative offsets.
* The static margin reported is the value at launch, not the maximum over the
  flight.

## Packaging

* Windows: `packaging/windows/build.ps1` then `make-installer.ps1`. The installer
  is a 6 KB C# stub with the zip appended (`packaging/windows/installer/Program.cs`);
  IExpress does not work at this payload size.
* macOS: `packaging/macos/build-app.sh`, run by `.github/workflows/macos.yml` on
  GitHub's own Macs. Nothing here produces a Mac build on Windows.
* Both fail loudly if the 23.09 jar is missing, because the bundle would install
  and then convert nothing.

## Commits

State what was measured or observed, not what was intended. When a number changes,
put the old and new value in the message.
