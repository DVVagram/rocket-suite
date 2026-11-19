#!/usr/bin/env bash
# Build RocketSuite.app for macOS: a linked Java runtime, a standalone CPython
# with the RocketPy stack, the application jar, the sidecar and the converter jar,
# wrapped in a double-clickable .app (and a .dmg when hdiutil is available).
#
# Run on macOS, from the repository root:
#   ./packaging/macos/build-app.sh --python /path/to/cpython-3.12+ --site-packages /path/to/lib/python3.12/site-packages
#
# The JDK is found from JAVA_HOME or --jdk. The Python must be a standalone build
# (relocatable), such as python-build-standalone or a Homebrew python copied out;
# a virtual environment will not work because it points at its base interpreter.
#
# Preparing the inputs on a Mac:
#   python3.12 -m venv .venv-mac
#   .venv-mac/bin/pip install rocketpy==1.13.0 rocketserializer==0.2.0
#   ./packaging/macos/build-app.sh --python <standalone CPython prefix> \
#       --site-packages .venv-mac/lib/python3.12/site-packages
# A standalone CPython is a relocatable build such as python-build-standalone; the
# Homebrew python is not relocatable as a whole. The vendored OpenRocket 23.09 jar
# is plain Java and works unchanged; copy it to .integration-src/RocketSerializer/.
#
# This script has not been run: it was written on Windows, where a macOS bundle
# cannot be produced. Treat the first run on a Mac as the test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

JDK="${JAVA_HOME:-}"
PYTHON=""
SITE_PACKAGES=""
VENDOR_JAR=".integration-src/RocketSerializer/OpenRocket-23.09.jar"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --jdk) JDK="$2"; shift 2 ;;
        --python) PYTHON="$2"; shift 2 ;;
        --site-packages) SITE_PACKAGES="$2"; shift 2 ;;
        --vendor-jar) VENDOR_JAR="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

[[ "$(uname -s)" == "Darwin" ]] || { echo "this script builds a macOS app and must run on macOS" >&2; exit 1; }
[[ -n "$JDK" && -x "$JDK/bin/jlink" ]] || { echo "no JDK 17: set JAVA_HOME or pass --jdk" >&2; exit 1; }
[[ -n "$PYTHON" && -x "$PYTHON/bin/python3" ]] || { echo "pass --python <standalone CPython prefix>" >&2; exit 1; }
[[ -n "$SITE_PACKAGES" && -d "$SITE_PACKAGES" ]] || { echo "pass --site-packages <the venv's site-packages>" >&2; exit 1; }
[[ -f swing/build/libs/swing-24.12-all.jar ]] || { echo "build the jar first: ./gradlew :swing:shadowJar" >&2; exit 1; }

DIST="$ROOT/dist/RocketSuite.app"
rm -rf "$DIST" "$ROOT/dist/_build_mac"
mkdir -p "$DIST/Contents/MacOS" "$DIST/Contents/Resources"

APP="$DIST/Contents/Resources/RocketSuite"
mkdir -p "$APP"

echo "[package] linking a Java runtime"
MODULES="java.base,java.compiler,java.desktop,java.logging,java.naming,java.prefs,java.sql,java.xml,java.xml.crypto,java.scripting,jdk.management,jdk.unsupported,jdk.zipfs"
"$JDK/bin/jlink" --add-modules "$MODULES" --strip-debug --no-header-files --no-man-pages \
    --compress=2 --output "$APP/runtime/jre"

echo "[package] copying Python"
mkdir -p "$APP/runtime"
rsync -a --exclude 'Tests' --exclude 'test' --exclude 'include' --exclude 'lib/pkgconfig' \
    "$PYTHON/" "$APP/runtime/python/"

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
else
    echo "warning: no converter jar at $VENDOR_JAR; conversion will not work" >&2
fi

echo "[package] writing the launcher"
cat > "$DIST/Contents/MacOS/RocketSuite" <<'LAUNCHER'
#!/bin/bash
# RocketSuite: OpenRocket with the RocketPy tab.
APP="$(cd "$(dirname "$0")/../Resources/RocketSuite" && pwd)"
export ROCKETSUITE_PYTHON="$APP/runtime/python/bin/python3"
export ROCKETSUITE_SIDECAR="$APP/app/sidecar/rocketpy_sidecar.py"
export ROCKETSUITE_ORK_JAR="$APP/app/vendor/OpenRocket-23.09.jar"
export PYTHONHOME="$APP/runtime/python"
export PYTHONPATH="$APP/lib/python"
export PYTHONNOUSERSITE=1
exec "$APP/runtime/jre/bin/java" -Xdock:name="Rocket Suite" \
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
</dict>
</plist>
PLIST

SIZE_MB=$(du -sm "$DIST" | cut -f1)
echo "[package] RocketSuite.app is ${SIZE_MB} MB"

if command -v hdiutil >/dev/null; then
    echo "[package] building the disk image"
    rm -f "$ROOT/dist/RocketSuite.dmg"
    hdiutil create -volname "Rocket Suite" -srcfolder "$DIST" -ov -format UDZO \
        "$ROOT/dist/RocketSuite.dmg" >/dev/null
    DMG_MB=$(du -sm "$ROOT/dist/RocketSuite.dmg" | cut -f1)
    echo "[package] RocketSuite.dmg is ${DMG_MB} MB"
fi

echo "[package] the app is unsigned, so the first launch needs right-click > Open,"
echo "          or: xattr -dr com.apple.quarantine /Applications/RocketSuite.app"
