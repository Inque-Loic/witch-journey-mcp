param(
  [int]$TimeoutSec = 90,
  [int]$IntervalSec = 2,
  [switch]$SkipEndToEnd
)

$ErrorActionPreference = "Stop"

$bridgeUrl = $env:WITCH_JOURNEY_BRIDGE_URL
if ([string]::IsNullOrWhiteSpace($bridgeUrl)) {
  $bridgeUrl = "http://127.0.0.1:18171"
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$lastError = $null

function Invoke-WitchMcp {
  param(
    [Parameter(Mandatory = $true)][string]$Tool,
    [hashtable]$Arguments = @{}
  )

  if ($Arguments.Count -eq 0) {
    python (Join-Path $PSScriptRoot "mcp-call.py") $Tool
    return
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("witch-mcp-args-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    $Arguments | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
    python (Join-Path $PSScriptRoot "mcp-call.py") $Tool "@$tmp"
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Waiting up to $TimeoutSec seconds for $bridgeUrl/health ..."
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod -Uri "$bridgeUrl/health" -TimeoutSec 3
    Write-Host "Bridge is up:"
    $health | ConvertTo-Json -Depth 10

    Write-Host ""
    Write-Host "Running takeover readiness audit ..."
    Invoke-WitchMcp witch_takeover_audit @{ bridgeTimeoutMs = 5000; bridgePollMs = 250; includeScreenshot = $false }

    if ($SkipEndToEnd) {
      Write-Host ""
      Write-Host "Skipping end-to-end MCP verification because -SkipEndToEnd was set."
      exit 0
    }

    Write-Host ""
    Write-Host "Running end-to-end MCP verification ..."
    powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "verify-end-to-end.ps1")
    if ($LASTEXITCODE -ne 0) {
      throw ("verify-end-to-end failed with exit code " + $LASTEXITCODE)
    }
    exit 0
  } catch {
    $lastError = $_.Exception.Message
    Start-Sleep -Seconds $IntervalSec
  }
}

Write-Host ""
Write-Host "Timed out waiting for the bridge. Running diagnostics for evidence ..."
powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "diagnose-runtime.ps1")
Write-Error "Timed out waiting for the bridge. Last error: $lastError"
