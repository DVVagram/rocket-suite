@echo off
rem Launch Rocket Suite from this folder. Nothing needs to be installed:
rem the Java runtime, Python and the RocketPy stack all live beside this file.
setlocal
set "RS=%~dp0"
set "ROCKETSUITE_PYTHON=%RS%runtime\python\python.exe"
set "ROCKETSUITE_SIDECAR=%RS%app\sidecar\rocketpy_sidecar.py"
set "ROCKETSUITE_ORK_JAR=%RS%app\vendor\OpenRocket-23.09.jar"
set "PYTHONHOME=%RS%runtime\python"
set "PYTHONPATH=%RS%lib\python"
set "PYTHONNOUSERSITE=1"

if not exist "%RS%runtime\python\python.exe" (
    echo The bundle is incomplete: runtime\python is missing.
    pause
    exit /b 1
)
if not exist "%RS%app\swing-24.12-all.jar" (
    echo The bundle is incomplete: app\swing-24.12-all.jar is missing.
    pause
    exit /b 1
)

start "" "%RS%runtime\jre\bin\javaw.exe" -cp "%RS%app\swing-24.12-all.jar" info.openrocket.swing.startup.OpenRocket
endlocal
