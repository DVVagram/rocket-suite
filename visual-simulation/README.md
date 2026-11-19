# Visual flight simulation

A 3D flight simulation for **any design you can make in OpenRocket 24.12**.
It reads `.ork` files directly and flies them with JavaScript ports of
OpenRocket's own mass, Barrowman-stability and drag models, so the numbers in
the panel match the desktop application rather than a separate approximation.

![pipeline](https://img.shields.io/badge/design-%C2%B7%20parse%20%C2%B7%20mass%20%C2%B7%20aero%20%C2%B7%20fly%20%C2%B7%20render-1f6feb)

## Running it

```bash
cd visual-simulation
node serve.mjs
```

Then open <http://127.0.0.1:8099/visual-simulation/>. A static server is needed
because the app is made of ES modules; the server also exposes the example
designs that ship with OpenRocket (`core/src/main/resources/datafiles/examples`).

In the app you can pick a bundled example, drag in your own `.ork`, choose a
flight configuration, and change wind and launch-rail settings.

## What it reads

Every container and component form OpenRocket 24.12 can write:

| Area | Supported |
| --- | --- |
| Containers | ZIP archives (`.ork` with decals) and plain XML |
| Body shapes | nose cone, transition, body tube — conical, ogive (incl. secant), ellipsoid, power, parabolic, Haack; flipped nose cones; fore/aft shoulders with caps |
| Fins | trapezoid, elliptical, freeform point lists; cant, thickness, square/rounded/airfoil cross-sections, fillets |
| Tubes and rings | inner tube, tube coupler, centering ring, bulkhead, engine block, launch lug, rail button, tube fins |
| Mass and recovery | mass components, parachutes, streamers, shock cords |
| Assemblies | axial stages, pods, parallel boosters, all 14 motor clusters, multi-configuration motor mounts |
| Placement | `top` / `middle` / `bottom` / `absolute` axial methods, `surface` / `relative` / `absolute` radial methods, `auto` radii inherited exactly as OpenRocket resolves them |

## Physics

* **Mass and CG** — shell volumes integrated over the real radius profile,
  shoulders, rings, fin planforms and fillet beads, recovery-device surface and
  line densities, motor case and propellant.
* **Aerodynamics** — Barrowman normal-force coefficients with the Galejs
  body-lift extension; fin `CNa` including the transonic blend, supersonic
  `K1/K2/K3` terms and body-fin interference; skin friction with OpenRocket's
  `Cf`, Reynolds number and finish roughness; nose pressure-drag interpolators
  from NASA TR-R-100 data; boattail, base and stagnation drag; the
  angle-of-attack multiplier.
* **Atmosphere** — the layered ISA model OpenRocket uses, with Sutherland
  viscosity for Reynolds numbers.
* **Flight** — RK4 integration in three dimensions, launch-rail constraint,
  wind, weathercocking driven by the static margin, staging with per-motor
  ignition events, stage separation, ejection-charge delays, canopy/streamer
  drag and landing detection.

### Motors

Thrust curves are fetched from ThrustCurve.org — the same public database
OpenRocket uses — keyed by manufacturer, designation and case dimensions, and
cached in `localStorage`. A RASP `.eng` file can be loaded for custom motors. If
a motor cannot be resolved and you are offline, an estimated curve is used and
the UI says so explicitly.

## Validation

```bash
node test/validate.mjs
```

The harness loads all 17 designs bundled with OpenRocket, checks the geometry,
mass, centre of pressure and drag curve, then flies each design and compares
the apogee with the flight data OpenRocket itself stored inside the `.ork` file
(`<flightdata maxaltitude=…>`).

Current result: **mean absolute apogee error 15.5%**, maximum 29.9%, with 9 of
12 comparable flights inside 20%. The remaining spread comes from attitude and
staging details that this flight model simplifies (see below).

## Known differences from the desktop application

* Decal images are not applied; components use their paint colours.
* Attitude is modelled kinematically from the static margin, so pitch/roll
  damping moments and roll torque are not simulated.
* Pod and tube-fin aerodynamics use a reduced model.
* Staging ignites sequentially (sustainer last) and lower stages separate at
  their own burnout.

## Layout

```
visual-simulation/
  index.html, styles.css     UI shell
  serve.mjs                  static server
  src/xml.js                 XML reader
  src/zip.js                 .ork container reader
  src/ork.js                 design parser and component layout
  src/mass.js                mass / CG model
  src/aero.js                stability and drag model
  src/motors.js              RASP parsing and motor lookup
  src/flight.js              flight integrator
  src/geometry.js            Three.js meshes from the design
  src/scene.js               sky, pad, smoke, flame, canopy, cameras
  src/app.js                 application wiring
  test/validate.mjs          accuracy harness
  vendor/three.module.js     vendored Three.js (MIT)
```

## Nothing in OpenRocket was modified

The tree at the repository root is the unmodified source of the
`release-24.12` tag; this directory is additive. Because it is distributed with
OpenRocket's source, it is covered by the same GNU GPL v3 licence.
