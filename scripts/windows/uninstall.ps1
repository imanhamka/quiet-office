#Requires -Version 5.1
<#
.SYNOPSIS
  Stops the Quiet Office Windows host and removes its login entry.
.PARAMETER Purge
  Also removes %LOCALAPPDATA%\quiet-office (logs, WebView2 data) and host-state.json.
  config.json is yours and stays.
#>
[CmdletBinding()]
param([switch]$Purge)

$ErrorActionPreference = 'Stop'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

# Stopping the host also stops its server child (kill-on-close job object).
Get-Process -Name QuietOffice -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-ItemProperty -Path $RunKey -Name 'QuietOffice' -ErrorAction SilentlyContinue

if ($Purge) {
    Start-Sleep -Milliseconds 500
    $local = Join-Path $env:LOCALAPPDATA 'quiet-office'
    if (Test-Path $local) { Remove-Item -Recurse -Force $local }
    $state = Join-Path $env:APPDATA 'quiet-office\host-state.json'
    if (Test-Path $state) { Remove-Item -Force $state }
}
Write-Output 'Uninstalled. The build output under hosts\windows\bin stays; delete it by hand if you want.'
