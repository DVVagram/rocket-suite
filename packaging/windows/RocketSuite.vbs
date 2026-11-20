' Launch Rocket Suite without opening a command prompt.
Option Explicit

Dim shell, fso, root, javaw, appJar, env
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
javaw = root & "\runtime\jre\bin\javaw.exe"
appJar = root & "\app\swing-24.12-all.jar"

' Recover from a sidecar orphaned by an older frozen or closed app instance.
On Error Resume Next
shell.Run "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & _
    root & "\cleanup-stale-sidecars.ps1"" -InstallRoot """ & root & """", 0, True
Err.Clear
On Error GoTo 0

shell.CurrentDirectory = root
Set env = shell.Environment("PROCESS")
env("ROCKETSUITE_PYTHON") = root & "\runtime\python\python.exe"
env("ROCKETSUITE_SIDECAR") = root & "\app\sidecar\rocketpy_sidecar.py"
env("ROCKETSUITE_ORK_JAR") = root & "\app\vendor\OpenRocket-23.09.jar"
env("PYTHONHOME") = root & "\runtime\python"
env("PYTHONPATH") = root & "\lib\python"
env("PYTHONNOUSERSITE") = "1"

shell.Run """" & javaw & """ -cp """ & appJar & """ info.openrocket.swing.startup.OpenRocket", 0, False
