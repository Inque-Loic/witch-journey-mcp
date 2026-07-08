param(
  [int]$TimeoutSec = 90,
  [int]$IntervalSec = 2,
  [switch]$IncludeScreenshot
)

$ErrorActionPreference = "Stop"

$bridgeUrl = $env:WITCH_JOURNEY_BRIDGE_URL
if ([string]::IsNullOrWhiteSpace($bridgeUrl)) {
  $bridgeUrl = "http://127.0.0.1:18171"
}

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

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$lastError = $null

Write-Host "Waiting up to $TimeoutSec seconds for $bridgeUrl/health before takeover audit ..."
while ((Get-Date) -lt $deadline) {
  try {
    Invoke-RestMethod -Uri "$bridgeUrl/health" -TimeoutSec 3 | Out-Null
    Invoke-WitchMcp witch_takeover_audit @{
      bridgeTimeoutMs = 5000
      bridgePollMs = 250
      includeScreenshot = [bool]$IncludeScreenshot
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
Write-Error "Timed out waiting for the bridge before takeover audit. Last error: $lastError"
