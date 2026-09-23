<#
.SYNOPSIS
  Start Luck - AI Roulette Lab (Windows PowerShell 5.1 or PowerShell 7+).

.DESCRIPTION
  Works from any folder. Checks Node.js (22.13 or newer), runs "npm ci" if node_modules
  is missing, creates .env from .env.example if .env does not exist (never overwrites it),
  then runs "npm run dev" (default) or "npm start" (-Prod).
  It never installs anything globally and never stops other programs.

.PARAMETER Prod
  Build and serve the app on one port (http://127.0.0.1:3717) instead of development mode.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Prod
#>
[CmdletBinding()]
param(
  [switch]$Prod
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Repository root = parent of the folder this script lives in (independent of the current directory).
$RepoRoot = Split-Path -Parent $PSScriptRoot
$MinNode = [version]'22.13.0'

function Fail([string]$Message) {
  Write-Host ''
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

# On Windows call npm.cmd directly so a restrictive execution policy on npm.ps1 does not matter.
$npm = 'npm'
if ($env:OS -eq 'Windows_NT') { $npm = 'npm.cmd' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js was not found. Install Node.js 22 LTS (22.13 or newer) or 24 from https://nodejs.org/ and open a new PowerShell window.'
}
if (-not (Get-Command $npm -ErrorAction SilentlyContinue)) {
  Fail 'npm was not found. It is installed together with Node.js (https://nodejs.org/).'
}

$nodeVersionText = ((& node -p 'process.versions.node') | Out-String).Trim()
$nodeVersion = $null
if (-not [version]::TryParse($nodeVersionText, [ref]$nodeVersion)) {
  Fail "Could not read the Node.js version (got '$nodeVersionText')."
}
if ($nodeVersion -lt $MinNode) {
  Fail "Node.js $nodeVersionText is too old. Luck needs Node.js $MinNode or newer (22 LTS or 24). Download it from https://nodejs.org/."
}

$exitCode = 1
Push-Location -LiteralPath $RepoRoot
try {
  Write-Host "Luck folder: $RepoRoot"
  Write-Host "Node.js:     $nodeVersionText"

  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules'))) {
    Write-Host 'Installing dependencies (npm ci)...'
    & $npm ci
    if ($LASTEXITCODE -ne 0) { Fail "npm ci failed (exit code $LASTEXITCODE). See docs\troubleshooting.md." }
  }

  $envFile = Join-Path $RepoRoot '.env'
  $envExample = Join-Path $RepoRoot '.env.example'
  if ((-not (Test-Path -LiteralPath $envFile)) -and (Test-Path -LiteralPath $envExample)) {
    Copy-Item -LiteralPath $envExample -Destination $envFile
    Write-Host 'Created .env from .env.example (edit it to add optional API keys).'
  }

  if ($Prod) {
    Write-Host 'Building and starting the one-port app. Open the address it prints (default http://127.0.0.1:3717).'
    & $npm start
  } else {
    Write-Host 'Starting development mode. Open http://127.0.0.1:5717 (or your LUCK_WEB_PORT) once it is ready.'
    & $npm run dev
  }
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $exitCode
