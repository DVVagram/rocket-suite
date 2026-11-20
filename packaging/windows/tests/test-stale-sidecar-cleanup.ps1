param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [string]$PythonExecutable = (Join-Path $InstallRoot "runtime\python\python.exe")
)

$ErrorActionPreference = "Stop"
$python = $PythonExecutable
$sidecar = Join-Path $InstallRoot "app\sidecar\rocketpy_sidecar.py"
$cleanup = Join-Path $InstallRoot "cleanup-stale-sidecars.ps1"
$token = [Guid]::NewGuid().ToString("N")
$stub = Join-Path $env:TEMP "rocketsuite-orphan-$token.py"
$pidFile = Join-Path $env:TEMP "rocketsuite-orphan-$token.pid"
$orphanId = $null

try {
    $stubSource = 'import os, time; open(os.environ["ROCKETSUITE_TEST_PIDFILE"], "w").write(str(os.getpid())); time.sleep(300)'
    Set-Content -LiteralPath $stub -Value $stubSource -Encoding ascii

    $env:ROCKETSUITE_TEST_PYTHON = $python
    $env:ROCKETSUITE_TEST_STUB = $stub
    $env:ROCKETSUITE_TEST_SIDECAR = $sidecar
    $env:ROCKETSUITE_TEST_PIDFILE = $pidFile
    $spawnInfo = [Diagnostics.ProcessStartInfo]::new()
    $spawnInfo.FileName = $env:ComSpec
    $spawnInfo.Arguments = '/d /c start "" /b "{0}" "{1}" "{2}"' -f $python, $stub, $sidecar
    $spawnInfo.CreateNoWindow = $true
    $spawnInfo.UseShellExecute = $false
    $spawn = [Diagnostics.Process]::Start($spawnInfo)
    if (-not $spawn.WaitForExit(10000)) {
        $spawn.Kill()
        throw "timed out creating an orphaned sidecar test process"
    }
    for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $pidFile); $attempt++) {
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $pidFile)) {
        throw "could not create the orphaned sidecar test process"
    }

    $orphanId = [int](Get-Content -LiteralPath $pidFile -Raw)
    if (-not (Get-Process -Id $orphanId -ErrorAction SilentlyContinue)) {
        throw "the orphan test process exited before cleanup ran"
    }

    $cleanupInfo = [Diagnostics.ProcessStartInfo]::new()
    $cleanupInfo.FileName = "powershell.exe"
    $cleanupInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallRoot "{1}"' -f $cleanup, $InstallRoot
    $cleanupInfo.CreateNoWindow = $true
    $cleanupInfo.UseShellExecute = $false
    $cleanupRun = [Diagnostics.Process]::Start($cleanupInfo)
    if (-not $cleanupRun.WaitForExit(15000)) {
        $cleanupRun.Kill()
        throw "stale sidecar cleanup did not finish within 15 seconds"
    }
    if ($cleanupRun.ExitCode -ne 0) {
        throw "stale sidecar cleanup returned $($cleanupRun.ExitCode)"
    }

    for ($attempt = 0; $attempt -lt 50 -and (Get-Process -Id $orphanId -ErrorAction SilentlyContinue); $attempt++) {
        Start-Sleep -Milliseconds 100
    }
    if (Get-Process -Id $orphanId -ErrorAction SilentlyContinue) {
        throw "the orphaned Python sidecar process was not stopped"
    }
    Write-Host "orphaned Python sidecar was stopped before app launch"
} finally {
    if ($orphanId) {
        Stop-Process -Id $orphanId -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $stub, $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\ROCKETSUITE_TEST_PYTHON -ErrorAction SilentlyContinue
    Remove-Item Env:\ROCKETSUITE_TEST_STUB -ErrorAction SilentlyContinue
    Remove-Item Env:\ROCKETSUITE_TEST_SIDECAR -ErrorAction SilentlyContinue
    Remove-Item Env:\ROCKETSUITE_TEST_PIDFILE -ErrorAction SilentlyContinue
}
