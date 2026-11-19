#!/usr/bin/env bash
# Build RocketSuite.app for macOS: a linked Java runtime, a standalone CPython
# with the RocketPy stack, the application jar, the sidecar and the converter jar,
# wrapped in a double-clickable .app and a .dmg.
#
# Run on macOS, from the repository root:
#   ./packaging/macos/build-app.sh --jdk "$JAVA_HOME" \
#       --python "$(uv python find 3.12)" \
#       --site-packages .venv-mac/lib/python3.12/site-packages
#
# --python takes either a standalone CPython prefix or the interpreter itself.
# The build must be relocatable (python-build-standalone, which is what `uv python
# install` fetches); a virtual environment will not do, because it points at its
# base interpreter.
#
# Preparing the inputs on a Mac:
#   curl -LsSf https://astral.sh/uv/install.sh | sh
#   uv python install 3.12
#   uv venv --python 3.12 .venv-mac
#   uv pip install --python .venv-mac/bin/python3 rocketpy==1.13.0 rocketserializer==0.2.0
#   (.venv-mac/bin/python3 -c 'import sys; print(sys.base_prefix)'  gives the prefix)
# The vendored OpenRocket 23.09 jar is plain Java and works unchanged:
#   curl -L -o .integration-src/RocketSerializer/OpenRocket-23.09.jar \
#       https://github.com/openrocket/openrocket/releases/download/release-23.09/OpenRocket-23.09.jar
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

JDK="${JAVA_HOME:-}"
PYTHON=""
SITE_PACKAGES=""
VENDOR_JAR=".integration-src/RocketSerializer/OpenRocket-23.09.jar"
ALLOW_MISSING_VENDOR_JAR=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --jdk) JDK="$2"; shift 2 ;;
        --python) PYTHON="$2"; shift 2 ;;
        --site-packages) SITE_PACKAGES="$2"; shift 2 ;;
        --vendor-jar) VENDOR_JAR="$2"; shift 2 ;;
        --allow-missing-vendor-jar) ALLOW_MISSING_VENDOR_JAR=1; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

[[ "$(uname -s)" == "Darwin" ]] || { echo "this script builds a macOS app and must run on macOS" >&2; exit 1; }
[[ -n "$JDK" && -x "$JDK/bin/jlink" ]] || { echo "no JDK 17: set JAVA_HOME or pass --jdk" >&2; exit 1; }
[[ -n "$PYTHON" ]] || { echo "pass --python <standalone CPython prefix or interpreter>" >&2; exit 1; }
[[ -n "$SITE_PACKAGES" && -d "$SITE_PACKAGES" ]] || { echo "pass --site-packages <the venv's site-packages>" >&2; exit 1; }
[[ -f swing/build/libs/swing-24.12-all.jar ]] || { echo "build the jar first: ./gradlew :swing:shadowJar" >&2; exit 1; }

# Accept the interpreter or its prefix; the layout below it is the same either way.
if [[ -f "$PYTHON" ]]; then
    PYTHON_PREFIX="$(cd "$(dirname "$PYTHON")/.." && pwd)"
else
    PYTHON_PREFIX="$PYTHON"
fi
[[ -x "$PYTHON_PREFIX/bin/python3" ]] || { echo "no bin/python3 under $PYTHON_PREFIX" >&2; exit 1; }

if [[ ! -f "$VENDOR_JAR" ]]; then
    if [[ "$ALLOW_MISSING_VENDOR_JAR" == "1" ]]; then
        echo "warning: no converter jar at $VENDOR_JAR; conversion will not work in this bundle" >&2
    else
        echo "no converter jar at $VENDOR_JAR" >&2
        echo "the app would install and fly nothing, so this stops here. Fetch it with:" >&2
        echo "  curl -L -o $VENDOR_JAR https://github.com/openrocket/openrocket/releases/download/release-23.09/OpenRocket-23.09.jar" >&2
        echo "or pass --vendor-jar <path>, or --allow-missing-vendor-jar to build anyway." >&2
        exit 1
    fi
fi

DIST="$ROOT/dist/RocketSuite.app"
STAGE="$ROOT/dist/_dmg_stage"
rm -rf "$DIST" "$STAGE" "$ROOT/dist/RocketSuite.dmg"
mkdir -p "$DIST/Contents/MacOS" "$DIST/Contents/Resources"

APP="$DIST/Contents/Resources/RocketSuite"
mkdir -p "$APP"

echo "[package] linking a Java runtime"
MODULES="java.base,java.compiler,java.desktop,java.logging,java.naming,java.prefs,java.sql,java.xml,java.xml.crypto,java.scripting,jdk.management,jdk.unsupported,jdk.zipfs"
"$JDK/bin/jlink" --add-modules "$MODULES" --strip-debug --no-header-files --no-man-pages \
    --compress=2 --output "$APP/runtime/jre"
[[ -f "$APP/runtime/jre/lib/server/libjvm.dylib" ]] || { echo "the linked runtime has no libjvm.dylib" >&2; exit 1; }

echo "[package] copying Python"
mkdir -p "$APP/runtime"
rsync -a --exclude 'Tests' --exclude 'test' --exclude 'include' --exclude 'lib/pkgconfig' \
    "$PYTHON_PREFIX/" "$APP/runtime/python/"

echo "[package] copying RocketPy stack"
mkdir -p "$APP/lib"
rsync -a --exclude 'tests' --exclude 'test' --exclude 'docs' \
    "$SITE_PACKAGES/" "$APP/lib/python/"

echo "[package] copying the application"
mkdir -p "$APP/app/vendor"
cp swing/build/libs/swing-24.12-all.jar "$APP/app/"
cp -R sidecar "$APP/app/sidecar"
rm -rf "$APP/app/sidecar/tests" "$APP/app/sidecar/__pycache__"
if [[ -f "$VENDOR_JAR" ]]; then
    cp "$VENDOR_JAR" "$APP/app/vendor/OpenRocket-23.09.jar"
fi

echo "[package] writing the launcher"
cat > "$DIST/Contents/MacOS/RocketSuite" <<'LAUNCHER'
#!/bin/bash
# RocketSuite: OpenRocket with the RocketPy tab.
APP="$(cd "$(dirname "$0")/../Resources/RocketSuite" && pwd)"
export ROCKETSUITE_PYTHON="$APP/runtime/python/bin/python3"
export ROCKETSUITE_SIDECAR="$APP/app/sidecar/rocketpy_sidecar.py"
export ROCKETSUITE_ORK_JAR="$APP/app/vendor/OpenRocket-23.09.jar"
# The converter starts a JVM from inside Python, so it needs the JVM we ship.
export ROCKETSUITE_JAVA_HOME="$APP/runtime/jre"
export JAVA_HOME="$APP/runtime/jre"
export PYTHONHOME="$APP/runtime/python"
export PYTHONPATH="$APP/lib/python"
export PYTHONNOUSERSITE=1
export PATH="$APP/runtime/jre/bin:$PATH"
exec "$APP/runtime/jre/bin/java" -Xdock:name="Rocket Suite" \
    -Dapple.awt.application.name="Rocket Suite" \
    -cp "$APP/app/swing-24.12-all.jar" info.openrocket.swing.startup.OpenRocket "$@"
LAUNCHER
chmod +x "$DIST/Contents/MacOS/RocketSuite"

cat > "$DIST/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Rocket Suite</string>
    <key>CFBundleDisplayName</key><string>Rocket Suite</string>
    <key>CFBundleIdentifier</key><string>org.rocketsuite.desktop</string>
    <key>CFBundleVersion</key><string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>RocketSuite</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
    <key>NSHumanReadableCopyright</key><string>GPL-3.0. Based on OpenRocket 24.12; RocketPy is separate.</string>
</dict>
</plist>
PLIST

# An Apple Silicon Mac will not start a modified Mach-O that carries no signature,
# and jlink rewrites the JVM's own binaries, so the bundle is ad-hoc signed. This
# is not notarisation: it turns "Killed: 9" into a normal Gatekeeper prompt.
echo "[package] signing (ad hoc)"
xattr -cr "$DIST" 2>/dev/null || true
if command -v codesign >/dev/null; then
    codesign --force --deep --sign - "$DIST" >/dev/null
else
    echo "warning: no codesign on PATH; the app may be killed on Apple Silicon" >&2
fi

SIZE_MB=$(du -sm "$DIST" | cut -f1)
echo "[package] RocketSuite.app is ${SIZE_MB} MB"

echo "[package] building the disk image"
mkdir -p "$STAGE"
cp -R "$DIST" "$STAGE/Rocket Suite.app"
cat > "$STAGE/Read me first.txt" <<'NOTE'
Rocket Suite - OpenRocket with a RocketPy tab
=============================================

Drag "Rocket Suite.app" into the Applications folder, then open it.

The app is not signed with an Apple developer certificate, so the first launch
is stopped by Gatekeeper. Either:

  * right-click (or Control-click) the app, choose Open, then Open again; or
  * run this once in Terminal:

        xattr -dr com.apple.quarantine "/Applications/Rocket Suite.app"

Nothing else needs installing: the Java runtime and Python are inside the app.

Design in OpenRocket's own tabs, run its simulation, switch to the RocketPy tab
to convert the design and fly it there. Known limits are in PLAN.md on GitHub.

Licence: GPL-3.0, as OpenRocket. Source: https://github.com/DVVagram/rocket-suite
NOTE

hdiutil create -volname "Rocket Suite" -srcfolder "$STAGE" -ov -format UDZO \
    "$ROOT/dist/RocketSuite.dmg" >/dev/null
rm -rf "$STAGE"
DMG_MB=$(du -sm "$ROOT/dist/RocketSuite.dmg" | cut -f1)
echo "[package] RocketSuite.dmg is ${DMG_MB} MB"
echo "[package] the app is ad-hoc signed only, so the first launch needs a"
echo "          right-click > Open, or the xattr line in the dmg's read-me."
