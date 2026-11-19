@echo off
rem Removes the shortcuts and the "Apps & features" entry, then optionally the
rem folder itself. Settings in the registry and your designs are left alone.
setlocal
rem Drop the trailing backslash: "C:\dir\" would swallow the closing quote.
set "RS=%~dp0"
set "RS=%RS:~0,-1%"
set "SHORTCUTS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Rocket Suite"
set "DESKTOP=%USERPROFILE%\Desktop"
set "KEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\RocketSuite"

if exist "%SHORTCUTS%" rmdir /s /q "%SHORTCUTS%"
if exist "%DESKTOP%\Rocket Suite.lnk" del "%DESKTOP%\Rocket Suite.lnk"
reg delete "%KEY%" /f >nul 2>&1

echo Rocket Suite was removed from the Start menu and from Apps and features.
set /p REMOVE="Delete this folder as well? [y/N] "
if /i "%REMOVE%"=="y" (
    rem Leave the batch file alone until it has finished, then remove the folder.
    cd /d "%TEMP%"
    rmdir /s /q "%RS%"
    echo Folder deleted.
) else (
    echo The folder and your designs were kept.
)
endlocal
