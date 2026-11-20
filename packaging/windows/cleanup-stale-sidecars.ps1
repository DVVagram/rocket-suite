param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
$appJar = [IO.Path]::GetFullPath((Join-Path $InstallRoot "app\swing-24.12-all.jar"))
$sidecar = [IO.Path]::GetFullPath((Join-Path $InstallRoot "app\sidecar\rocketpy_sidecar.py"))

try {
    $processes = @(Get-CimInstance Win32_Process)
} catch {
    # Cleanup is best-effort; a WMI failure must never prevent OpenRocket starting.
    exit 0
}

$byId = @{}
foreach ($process in $processes) {
    $byId[[uint32]$process.ProcessId] = $process
}

foreach ($process in $processes) {
    if ($process.Name -ine "python.exe" -or -not $process.CommandLine) {
        continue
    }
    if ($process.CommandLine.IndexOf($sidecar, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        continue
    }

    $parent = $byId[[uint32]$process.ParentProcessId]
    if ($parent) {
        $parentIsRocketSuite = $parent.Name -iin @("java.exe", "javaw.exe") -and
                $parent.CommandLine -and
                $parent.CommandLine.IndexOf($appJar, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if ($parentIsRocketSuite) {
            continue
        }

        # A Windows PID can be reused after the original Java process exits.
        # Preserve a live non-app parent unless its start time proves reuse.
        try {
            $childStarted = [Management.ManagementDateTimeConverter]::ToDateTime($process.CreationDate)
            $parentStarted = [Management.ManagementDateTimeConverter]::ToDateTime($parent.CreationDate)
            if ($parentStarted -le $childStarted) {
                continue
            }
        } catch {
            # If timing data is unavailable, leave an ambiguous live process alone.
            continue
        }
    }

    try {
        Invoke-CimMethod -InputObject $process -MethodName Terminate | Out-Null
    } catch {
        # It may have exited between the process snapshot and termination.
    }
}
