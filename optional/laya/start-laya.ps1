<#
.SYNOPSIS
  Start the OPTIONAL local Laya classifier server (laya-serve) for Luck - AI Roulette Lab.

.DESCRIPTION
  Works from any folder. Uses the separate virtual environment <repo>\.venv-laya and always binds
  laya-serve to 127.0.0.1 (laya-serve's own default is 0.0.0.0, which would expose it to the network).
  Nothing here is part of the base npm install. It never installs anything globally.

  First run downloads the model weights from Hugging Face (roughly 0.6-2.3 GB depending on the
  checkpoints used), so the first classification can take a long time.

.PARAMETER Install
  Create .venv-laya (if missing) and install optional/laya/requirements.txt into it, then start.

.PARAMETER Port
  Port for laya-serve (default 8000, matching LAYA_BASE_URL=http://127.0.0.1:8000).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\optional\laya\start-laya.ps1 -Install

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\optional\laya\start-laya.ps1 -Port 8010
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Repository root = two levels above this script (optional\laya\start-laya.ps1).
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Venv = Join-Path $RepoRoot '.venv-laya'
$VenvPython = Join-Path $Venv 'Scripts\python.exe'
$Requirements = Join-Path $PSScriptRoot 'requirements.txt'

function Fail([string]$Message) {
  Write-Host ''
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

if ($Port -lt 1 -or $Port -gt 65535) { Fail "Port must be between 1 and 65535 (got $Port)." }

if ($Install) {
  if (-not (Test-Path $VenvPython)) {
    $python = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
    Write-Host "Creating virtual environment $Venv ..."
    & $python -m venv $Venv
    if ($LASTEXITCODE -ne 0) { Fail "Could not create the virtual environment with '$python'. Install Python 3 or set `$env:PYTHON." }
  }
  Write-Host 'Installing optional/laya/requirements.txt into .venv-laya ...'
  & $VenvPython -m pip install -r $Requirements
  if ($LASTEXITCODE -ne 0) { Fail 'pip install failed (see the output above).' }
}

if (-not (Test-Path $VenvPython)) {
  Fail "No Laya environment found at $Venv. Run this script with -Install first (see optional\laya\README.md)."
}

$Serve = Join-Path $Venv 'Scripts\laya-serve.exe'
if (-not (Test-Path $Serve)) {
  Fail "laya-serve is not installed in $Venv. Run this script with -Install."
}

# Loopback only, always. LAYA_API_KEY (if set in this shell) is passed through by laya-serve itself;
# put the same value in the app's .env as LAYA_API_KEY.
$env:LAYA_HOST = '127.0.0.1'
$env:LAYA_PORT = [string]$Port

Write-Host "Starting laya-serve on http://127.0.0.1:$Port (Ctrl+C to stop) ..."
& $Serve
exit $LASTEXITCODE
