<#
Assemble the Windows bundle: a jlink runtime, a standalone CPython with the
RocketPy stack, the application jar and the converter's OpenRocket jar, plus a
launcher. Produces dist\RocketSuite and dist\RocketSuite-portable.zip.

Run from the repository root:
    powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1

Nothing here needs to be installed on the target machine: no Java, no Python.
#>
param(
    [string]$Jdk = "tools\jdk-17.0.21+9",
    [string]$Python = "",
    [string]$SitePackages = ".venv\Lib\site-packages",
    [string]$VendorJar = ".integration-src\RocketSerializer\OpenRocket-23.09.jar",
    [switch]$AllowMissingVendorJar
)

$ErrorActionPreference = "Stop"
$root = (Get-Item $PSScriptRoot).Parent.Parent.FullName
Set-Location $root

$dist = Join-Path $root "dist\RocketSuite"
$build = Join-Path $root "dist\_build"

function Step($message) { Write-Host "[package] $message" }

# --- clean -------------------------------------------------------------------
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force -Path $dist, $build | Out-Null

# --- Java runtime ------------------------------------------------------------
$jlink = Join-Path $Jdk "bin\jlink.exe"
if (-not (Test-Path $jlink)) { throw "no jlink at $jlink; pass -Jdk <jdk17>" }
Step "linking a Java runtime"
$modules = @(
    "java.base", "java.compiler", "java.desktop", "java.logging", "java.naming",
    "java.prefs", "java.sql", "java.xml", "java.xml.crypto", "java.scripting",
    "jdk.management", "jdk.unsupported", "jdk.zipfs"
) -join ","
& $jlink --add-modules $modules --strip-debug --no-header-files --no-man-pages `
    --compress=2 --output "$dist\runtime\jre"
if ($LASTEXITCODE -ne 0) { throw "jlink failed" }
if (-not (Test-Path "$dist\runtime\jre\bin\server\jvm.dll")) {
    throw "the linked runtime has no jvm.dll, so the converter could not start a JVM"
}

# --- Python runtime ----------------------------------------------------------
# The venv is not relocatable (it points at its base interpreter), so the base
# interpreter is copied instead and the packages travel beside it.
if (-not $Python) {
    $Python = (& (Join-Path $root ".venv\Scripts\python.exe") -c "import sys; print(sys.base_prefix)").Trim()
}
if (-not (Test-Path "$Python\python.exe")) { throw "no standalone Python at $Python" }
Step "copying the Python runtime from $Python"
$excludeDirs = @("Scripts", "include", "libs", "tcl", "BUILD", "Doc", "test", "idlelib", "tkinter", "turtledemo", "site-packages")
$excludeArgs = $excludeDirs | ForEach-Object { "/XD", $_ }
& robocopy $Python "$dist\runtime\python" /E /NFL /NDL /NJH /NJS /NP @excludeArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying Python ($LASTEXITCODE)" }

# --- RocketPy stack ----------------------------------------------------------
# Copied whole on purpose: pruning directories named "test" removes numpy/testing,
# which scipy imports, and removing *.dist-info makes importlib.metadata return
# no version for RocketPy.
Step "copying site-packages"
& robocopy $SitePackages "$dist\lib\python" /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying site-packages ($LASTEXITCODE)" }

# pip and setuptools are never used at run time; their metadata is not needed.
foreach ($junk in @("$dist\lib\python\pip", "$dist\lib\python\setuptools",
                    "$dist\lib\python\pip-*.dist-info", "$dist\lib\python\setuptools-*.dist-info")) {
    if (Test-Path $junk) { Remove-Item -Recurse -Force $junk }
}

# --- application -------------------------------------------------------------
Step "copying the application"
New-Item -ItemType Directory -Force -Path "$dist\app" | Out-Null
Copy-Item "swing\build\libs\swing-24.12-all.jar" "$dist\app\" -Force
Copy-Item "sidecar" "$dist\app\sidecar" -Recurse -Force
Get-ChildItem "$dist\app\sidecar" -Recurse -Include "__pycache__", "tests" |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$dist\app\vendor" | Out-Null
# A bundle without this jar installs, opens and then fails to convert anything, so
# it stops the build unless the caller says it is only after a throwaway bundle.
if (-not (Test-Path $VendorJar)) {
    if ($AllowMissingVendorJar) {
        Write-Warning "no OpenRocket 23 jar at $VendorJar; conversion will not work in this bundle"
    } else {
        throw @"
no converter jar at $VendorJar.
The installer would ship a RocketPy tab that cannot convert a design, so this stops here.
Fetch it with:
  curl -L -o $VendorJar https://github.com/openrocket/openrocket/releases/download/release-23.09/OpenRocket-23.09.jar
Or pass -VendorJar <path>, or -AllowMissingVendorJar to build anyway.
"@
    }
} else {
    Copy-Item $VendorJar "$dist\app\vendor\OpenRocket-23.09.jar" -Force
}

# --- launcher and notes ------------------------------------------------------
Copy-Item "packaging\windows\RocketSuite.bat" "$dist\RocketSuite.bat" -Force
Copy-Item "packaging\windows\README.txt" "$dist\README.txt" -Force
Copy-Item "packaging\windows\uninstall.cmd" "$dist\uninstall.cmd" -Force
Copy-Item "packaging\windows\setup.cmd" "$dist\setup.cmd" -Force

# --- zip ---------------------------------------------------------------------
$zip = Join-Path $root "dist\RocketSuite-portable.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Step "compressing (this is the slow part)"
# Three things rule out the easy tools. tar on PATH is GNU tar, whose -a cannot
# write a zip and quietly produces a tar file with a .zip name. Compress-Archive
# fails on one file in the Python tree. And CreateFromDirectory writes Windows
# backslashes into the entry names, which Explorer tolerates but which produce
# files with literal backslashes in their names on macOS, so the entries are
# written here with forward slashes as the zip format requires.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Create($zip)
$archive = New-Object System.IO.Compression.ZipArchive(
    $stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $prefixLength = $dist.Length + 1
    foreach ($file in Get-ChildItem $dist -Recurse -File) {
        $relative = "RocketSuite/" + $file.FullName.Substring($prefixLength).Replace('\', '/')
        $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $file.LastWriteTime
        $out = $entry.Open()
        $in = [System.IO.File]::OpenRead($file.FullName)
        try { $in.CopyTo($out) } finally { $in.Dispose(); $out.Dispose() }
    }
} finally {
    $archive.Dispose(); $stream.Dispose()
}
if (-not (Test-Path $zip)) { throw "archiving produced no $zip" }

$bundleMb = [math]::Round(((Get-ChildItem $dist -Recurse | Measure-Object Length -Sum).Sum / 1MB), 1)
Step "verifying the bundled Python can import the stack"
$env:PYTHONHOME = "$dist\runtime\python"
$env:PYTHONPATH = "$dist\lib\python"
$env:PYTHONNOUSERSITE = "1"
& "$dist\runtime\python\python.exe" -c "import rocketpy, rocketserializer, jpype, numpy, scipy, matplotlib; from importlib.metadata import version; print('rocketpy', version('rocketpy'))"
if ($LASTEXITCODE -ne 0) { throw "the bundled Python cannot import the RocketPy stack" }
Remove-Item Env:PYTHONHOME, Env:PYTHONPATH, Env:PYTHONNOUSERSITE
$zipMb = [math]::Round(((Get-Item $zip).Length / 1MB), 1)
Step "bundle $bundleMb MB on disk, zip $zipMb MB"
"BUNDLE_MB=$bundleMb" | Out-File -Append -Encoding utf8 "dist\sizes.txt"
"ZIP_MB=$zipMb" | Out-File -Append -Encoding utf8 "dist\sizes.txt"
