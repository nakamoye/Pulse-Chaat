# Pulse Chat launcher — finds Node even if it is not in PATH
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$candidates = @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  "$env:ProgramFiles\nodejs\node.exe",
  ${env:ProgramFiles(x86)} + '\nodejs\node.exe',
  "$env:LOCALAPPDATA\Programs\node\node.exe",
  "$env:LOCALAPPDATA\Programs\cursor\resources\app\resources\helpers\node.exe",
  "$env:LOCALAPPDATA\Programs\Cursor\resources\app\resources\helpers\node.exe",
  'C:\Program Files\Cursor\resources\app\resources\helpers\node.exe',
  'D:\cursor\resources\app\resources\helpers\node.exe',
  'C:\cursor\resources\app\resources\helpers\node.exe'
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$node = $candidates | Select-Object -First 1
if (-not $node) {
  Write-Host ''
  Write-Host 'Node.js not found.' -ForegroundColor Red
  Write-Host 'Install from https://nodejs.org/ (LTS) or run: node server.js' -ForegroundColor Yellow
  Read-Host 'Press Enter to exit'
  exit 1
}

Write-Host "Starting Pulse Chat on http://localhost:3847"
Write-Host "Using: $node"
Write-Host ''
& $node server.js
