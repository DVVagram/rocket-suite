Rocket Suite
============

OpenRocket 24.12 with one added tab: RocketPy.

Design the rocket on OpenRocket's own tabs, then switch to the "RocketPy" tab to
convert the design and fly it in RocketPy. OpenRocket owns the design (geometry,
mass, centre of gravity, inertia, stability, thrust and drag curves); RocketPy
owns the flight (atmosphere, gravity, forces, trajectory, events, apogee). Only
design inputs cross between them, one way.

Running it
----------
Double-click RocketSuite.vbs. This starts the app without opening a command window.
It also clears an orphaned Rocket Suite Python sidecar left by an earlier crash.

Nothing needs to be installed: the Java runtime and Python with the RocketPy
stack are inside this folder. Nothing is written outside it except the usual
OpenRocket settings and your design files.

First use of the RocketPy tab takes a few seconds: "Connect to RocketPy" starts
the flight engine, and the first "Convert design" loads the motor database.

Contents
--------
  RocketSuite.vbs        windowless launcher
  RocketSuite.bat        command-line launcher for troubleshooting
  runtime\jre            Java 17 runtime (linked, not a JDK)
  runtime\python         Python 3.12 runtime
  lib\python             RocketPy, RocketSerializer, numpy, scipy, matplotlib, ...
  app\swing-24.12-all.jar  the application
  app\sidecar            the Python process that runs RocketPy
  app\vendor             OpenRocket 23.09, used only to read .ork files

Notes
-----
* OpenRocket's own simulation must exist in the design before conversion: the
  converter takes mass and aerodynamic properties from it. Run OpenRocket's
  simulation on the "Flight simulation" tab first.
* The RocketPy tab converts the configuration selected in OpenRocket, so the
  motor and the comparison flight belong to the same design.
* The RocketPy tab has a console: Python typed there runs on the objects of the
  last flight. It is the full RocketPy API on your own machine.

License: GPL-3.0, as OpenRocket. Sources are in the repository this bundle was
built from.
