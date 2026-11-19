<#
Build dist\RocketSuite-Setup.exe: a single self-extracting installer.

It is three parts in one file: the stub compiled from installer\Program.cs, the
portable zip, and the stub's own length as the last eight bytes. Run, it unpacks
the zip to a temporary folder and runs the setup.cmd inside it, which installs
into %LOCALAPPDATA%\Programs\RocketSuite and adds shortcuts.

IExpress was the obvious tool, but it produces nothing at all for a payload this
size, silently; WiX, NSIS and Inno Setup are not installed. The C# compiler that
ships with the .NET Framework is enough.

Run after build.ps1:
    powershell -ExecutionPolicy Bypass -File packaging\windows\make-installer.ps1
#>
param(
    [string]$Zip = "dist\RocketSuite-portable.zip"
)

$ErrorActionPreference = "Stop"
$root = (Get-Item $PSScriptRoot).Parent.Parent.FullName
Set-Location $root

if (-not (Test-Path $Zip)) { throw "no $Zip; run build.ps1 first" }

$csc = Join-Path $env:SystemRoot "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:SystemRoot "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) { throw "no csc.exe from the .NET Framework; cannot build the installer" }

$stage = Join-Path $root "dist\_installer"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$stub = Join-Path $stage "RocketSuite-Setup-stub.exe"
Write-Host "[installer] compiling the stub"
$cscArgs = @(
    "/nologo", "/optimize+", "/target:winexe", "/platform:anycpu",
    "/out:$stub",
    "/r:System.IO.Compression.dll", "/r:System.IO.Compression.FileSystem.dll",
    "/r:System.Windows.Forms.dll",
    "packaging\windows\installer\Program.cs"
)
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }

$target = Join-Path $root "dist\RocketSuite-Setup.exe"
if (Test-Path $target) { Remove-Item -Force $target }

Write-Host "[installer] appending the payload to the stub"
$stubLength = (Get-Item $stub).Length
$output = [System.IO.File]::Create($target)
try {
    foreach ($part in @($stub, (Resolve-Path $Zip).Path)) {
        $input = [System.IO.File]::OpenRead($part)
        try { $input.CopyTo($output) } finally { $input.Dispose() }
    }
    $footer = [System.BitConverter]::GetBytes([Int64]$stubLength)
    $output.Write($footer, 0, $footer.Length)
} finally {
    $output.Dispose()
}

$mb = [math]::Round((Get-Item $target).Length / 1MB, 1)
Write-Host "[installer] $target $mb MB (stub $([math]::Round($stubLength/1KB)) KB)"
"INSTALLER_MB=$mb" | Out-File -Append -Encoding utf8 "dist\sizes.txt"
