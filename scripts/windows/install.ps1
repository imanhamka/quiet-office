#Requires -Version 5.1
<#
.SYNOPSIS
  Builds the Quiet Office Windows host (experimental) and starts it at login.
.DESCRIPTION
  Checks Node.js >= 22, the .NET 10 SDK and the WebView2 Runtime, publishes hosts\windows,
  adds the HKCU Run value "QuietOffice", then starts the host. The host runs the server itself.
.PARAMETER NoStart
  Install without starting the host now.
#>
[CmdletBinding()]
param([switch]$NoStart)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Project = Join-Path $Root 'hosts\windows\QuietOffice.csproj'
$Exe = Join-Path $Root 'hosts\windows\bin\Release\net10.0-windows\win-x64\publish\QuietOffice.exe'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js not found on PATH. Install Node.js 22 or newer, then run this script again.'
}
$nodeVersion = (& node --version).Trim().TrimStart('v')
if ([int]($nodeVersion.Split('.')[0]) -lt 22) {
    throw "Node.js $nodeVersion found on PATH. Quiet Office needs Node.js 22 or newer."
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'dotnet not found on PATH. Install the .NET 10 SDK, then run this script again.'
}
if (-not (& dotnet --list-sdks | Where-Object { $_ -match '^10\.' })) {
    throw 'No .NET 10 SDK found (dotnet --list-sdks). Install the .NET 10 SDK, then run this script again.'
}

if (-not (Test-Path (Join-Path $Root 'web\dist\index.html'))) {
    throw "web\dist\index.html not found under $Root. Build the page first (see README), then run this script again."
}

# WebView2 Evergreen Runtime client id; machine-wide or per-user install.
$wv2 = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$wv2Keys = @("HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv2",
             "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wv2",
             "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv2")
if (-not ($wv2Keys | Where-Object { Test-Path $_ })) {
    Write-Warning 'WebView2 Runtime not found. Windows 11 includes it; on Windows 10 install the Evergreen Runtime from Microsoft.'
}

# A running host locks its files; stopping it also stops its server child.
Get-Process -Name QuietOffice -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

& dotnet publish $Project -c Release -r win-x64 --self-contained false --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE). Read the build output above." }
if (-not (Test-Path $Exe)) { throw "Build output not found: $Exe" }

New-Item -ItemType Directory -Force -Path (Join-Path $env:LOCALAPPDATA 'quiet-office\logs') | Out-Null
$command = '"{0}" --repo "{1}"' -f $Exe, $Root
Set-ItemProperty -Path $RunKey -Name 'QuietOffice' -Value $command

if (-not $NoStart) {
    Start-Process -FilePath $Exe -ArgumentList ('--repo "{0}"' -f $Root)
}
Write-Output "Installed. Starts at login. Logs: $env:LOCALAPPDATA\quiet-office\logs"
