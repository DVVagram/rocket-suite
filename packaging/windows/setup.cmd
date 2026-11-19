@echo off
rem Installs Rocket Suite for the current user: puts the application in
rem %LOCALAPPDATA%\Programs\RocketSuite, adds Start menu and desktop shortcuts,
rem and registers it in "Apps and features". No administrator rights are needed
rem and nothing outside the user's profile is touched.
rem
rem Two shapes are supported so the same file works from the installer and from
rem the unpacked portable folder: with payload.zip beside it, the zip is
rem extracted; without it, this folder is copied.
setlocal
rem %~dp0 ends in a backslash, and a path ending in \" makes Windows drop the
rem closing quote, so tools would be handed a broken path and touch nothing.
set "SRC=%~dp0"
set "SRC=%SRC:~0,-1%"
set "DEST=%LOCALAPPDATA%\Programs\RocketSuite"
set "KEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\RocketSuite"

echo Installing Rocket Suite to "%DEST%"
if exist "%SRC%\payload.zip" goto fromzip
robocopy "%SRC%" "%DEST%" /E /XF setup.cmd payload.zip /NFL /NDL /NJH /NJS /NP >nul
goto verify

:fromzip
echo Extracting...
set "UNPACK=%TEMP%\RocketSuite-install"
if exist "%UNPACK%" rmdir /s /q "%UNPACK%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Add-Type -AssemblyName System.IO.Compression.FileSystem;" ^
  "[System.IO.Compression.ZipFile]::ExtractToDirectory('%SRC%\payload.zip', '%UNPACK%')"
if errorlevel 1 goto failed
if exist "%UNPACK%\RocketSuite" set "UNPACK=%UNPACK%\RocketSuite"
robocopy "%UNPACK%" "%DEST%" /E /XF setup.cmd payload.zip /NFL /NDL /NJH /NJS /NP >nul
rmdir /s /q "%UNPACK%"

:verify
rem robocopy's exit code is a bitmask where 8 means "some files skipped", which is
rem normal, so the install is judged by what is actually there afterwards.
if not exist "%DEST%\RocketSuite.vbs" goto failed
if not exist "%DEST%\runtime\python\python.exe" goto failed
if not exist "%DEST%\app\swing-24.12-all.jar" goto failed

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$dest = Join-Path $env:LOCALAPPDATA 'Programs\RocketSuite';" ^
  "$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs';" ^
  "New-Item -ItemType Directory -Force -Path (Join-Path $programs 'Rocket Suite') | Out-Null;" ^
  "$s = $ws.CreateShortcut((Join-Path $programs 'Rocket Suite\Rocket Suite.lnk'));" ^
  "$s.TargetPath = (Join-Path $dest 'RocketSuite.vbs'); $s.WorkingDirectory = $dest; $s.Save();" ^
  "$d = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Rocket Suite.lnk'));" ^
  "$d.TargetPath = (Join-Path $dest 'RocketSuite.vbs'); $d.WorkingDirectory = $dest; $d.Save();"
if errorlevel 1 goto failed

reg add "%KEY%" /v "DisplayName" /d "Rocket Suite" /f >nul
reg add "%KEY%" /v "DisplayVersion" /d "1.0" /f >nul
reg add "%KEY%" /v "Publisher" /d "Rocket Suite" /f >nul
reg add "%KEY%" /v "InstallLocation" /d "%DEST%" /f >nul
reg add "%KEY%" /v "UninstallString" /d "\"%DEST%\uninstall.cmd\"" /f >nul
reg add "%KEY%" /v "NoModify" /d 1 /t REG_DWORD /f >nul
reg add "%KEY%" /v "NoRepair" /d 1 /t REG_DWORD /f >nul

echo.
echo Rocket Suite is installed. Start it from the Start menu, or from the desktop
echo shortcut. Settings and designs are kept when it is uninstalled.
start "" "%DEST%\RocketSuite.vbs"
exit /b 0

:failed
echo.
echo The installation failed. Unzip the portable package somewhere and run
echo RocketSuite.bat directly instead: it needs nothing installed.
exit /b 1
