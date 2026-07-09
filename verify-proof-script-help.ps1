$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptPath = Join-Path $PSScriptRoot "prove-no-mouse-takeover.ps1"
$output = powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Help | Out-String
if ($LASTEXITCODE -ne 0) {
  throw ("prove-no-mouse-takeover.ps1 -Help failed with exit code " + $LASTEXITCODE)
}

$required = @(
  "Safe preview",
  "-Status",
  "-WaitForDllUnlock",
  "-WaitForBridgeAfterSync",
  "-ConfirmRestart RESTART_WITCH_GAME",
  "-OutputPath",
  "-SyncTimeoutSec",
  "-ExecuteStateAdvance",
  "-ExecuteProbes",
  "Exit codes",
  "Manual DLL unlock sync did not complete"
)

$missing = @($required | Where-Object { -not $output.Contains($_) })
if ($missing.Count -gt 0) {
  [pscustomobject]@{
    missing = $missing
    output = $output
  } | ConvertTo-Json -Depth 5
  throw "prove-no-mouse-takeover.ps1 -Help output is missing required text."
}

Write-Host "ok: proof script help output"
