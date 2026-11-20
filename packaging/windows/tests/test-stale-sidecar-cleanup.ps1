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
$spawner = Join-Path $env:TEMP "rocketsuite-spawner-$token.ps1"
$pidFile = Join-Path $env:TEMP "rocketsuite-orphan-$token.pid"
$orphanId = $null

try {
    Set-Content -LiteralPath $stub -Value "import time; time.sleep(300)" -Encoding ascii
    @'
$child = Start-Process -FilePath $env:ROCKETSUITE_TEST_PYTHON `
    -ArgumentList @("`"$env:ROCKETSUITE_TEST_STUB`"", "`"$env:ROCKETSUITE_TEST_SIDECAR`"") `
    -PassThru -WindowStyle Hidden
Set-Content -LiteralPath $env:ROCKETSUITE_TEST_PIDFILE -Value $child.Id -Encoding ascii
'@ | Set-Content -LiteralPath $spawner -Encoding ascii

    $env:ROCKETSUITE_TEST_PYTHON = $python
    $env:ROCKETSUITE_TEST_STUB = $stub
    $env:ROCKETSUITE_TEST_SIDECAR = $sidecar
    $env:ROCKETSUITE_TEST_PIDFILE = $pidFile
    $spawn = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-File", "`"$spawner`"") `
        -PassThru -Wait -WindowStyle Hidden
    if ($spawn.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $pidFile)) {
        throw "could not create the orphaned sidecar test process"
    }

    $orphanId = [int](Get-Content -LiteralPath $pidFile -Raw)
    if (-not (Get-Process -Id $orphanId -ErrorAction SilentlyContinue)) {
        throw "the orphan test process exited before cleanup ran"
    }

    $cleanupRun = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", "`"$cleanup`"", "-InstallRoot", "`"$InstallRoot`"") `
        -PassThru -Wait -WindowStyle Hidden
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
    Remove-Item -LiteralPath $stub, $spawner, $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\ROCKETSUITE_TEST_PYTHON -ErrorAction SilentlyContinue
    Remove-Item Env:\ROCKETSUITE_TEST_STUB -ErrorAction SilentlyContinue
    Remove-Item Env:\ROCKETSUITE_TEST_SIDECAR -ErrorAction SilentlyContinue
    Remove-Item Env:\ROCKETSUITE_TEST_PIDFILE -ErrorAction SilentlyContinue
}
