param(
  [string]$ConfirmRestart,
  [int]$TimeoutSec = 120,
  [int]$IntervalSec = 2,
  [switch]$SkipEndToEnd
)

$ErrorActionPreference = "Stop"

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

function Invoke-WitchMcpJson {
  param(
    [Parameter(Mandatory = $true)][string]$Tool,
    [hashtable]$Arguments = @{}
  )

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("witch-mcp-args-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    $Arguments | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
    $raw = python (Join-Path $PSScriptRoot "mcp-call.py") $Tool "@$tmp"
    $message = ($raw | Out-String) | ConvertFrom-Json
    if ($message.error) {
      throw ($message.error.message | Out-String)
    }
    return ($message.result.content[0].text | ConvertFrom-Json)
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

if ($ConfirmRestart -ne "RESTART_WITCH_GAME") {
  Write-Host "This script can close and restart Witch's Apocalyptic Journey."
  Write-Host "Re-run with: -ConfirmRestart RESTART_WITCH_GAME"
  Write-Host "No process was stopped."
  exit 2
}

Write-Host "Requesting confirmed restart through witch_prepare_takeover ..."
$prepare = Invoke-WitchMcpJson witch_prepare_takeover @{
  launchIfNotRunning = $true
  restartIfRunning = $true
  confirm = "RESTART_WITCH_GAME"
  gracefulCloseTimeoutMs = 8000
  waitBridge = $false
  runReadiness = $false
  includeScreenshot = $false
}
if ($prepare.ok -ne $true) {
  throw ("witch_prepare_takeover restart failed: " + ($prepare | ConvertTo-Json -Depth 20 -Compress))
}
$prepare | ConvertTo-Json -Depth 20

Write-Host ""
Write-Host "Waiting for restarted game bridge and running verification ..."
$args = @(
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $PSScriptRoot "wait-and-verify.ps1"),
  "-TimeoutSec", "$TimeoutSec",
  "-IntervalSec", "$IntervalSec"
)
if ($SkipEndToEnd) {
  $args += "-SkipEndToEnd"
}
powershell @args
if ($LASTEXITCODE -ne 0) {
  throw ("wait-and-verify failed with exit code " + $LASTEXITCODE)
}
