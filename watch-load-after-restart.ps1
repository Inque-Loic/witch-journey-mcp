param(
  [int]$TimeoutSec = 120,
  [int]$IntervalSec = 2,
  [int]$TailLines = 120,
  [switch]$IncludeScreenshot
)

$ErrorActionPreference = "Stop"

$bridgeUrl = $env:WITCH_JOURNEY_BRIDGE_URL
if ([string]::IsNullOrWhiteSpace($bridgeUrl)) {
  $bridgeUrl = "http://127.0.0.1:18171"
}

$playerLog = Join-Path $env:USERPROFILE "AppData\LocalLow\MeowAlive\Witch's Apocalyptic Journey\Player.log"
$startTime = Get-Date
$deadline = $startTime.AddSeconds($TimeoutSec)
$lastError = $null
$lastEvidenceText = ""

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

function Get-LogEvidence {
  param([int]$Last = 120)

  if (-not (Test-Path -LiteralPath $playerLog)) {
    return @()
  }

  try {
    Select-String `
      -LiteralPath $playerLog `
      -Pattern "CodexMcpBridge|ModConfig|Mods|ModInitialize|Entry\.dll|Entry\.lua|Exception|failed|error" |
      Select-Object -Last $Last |
      ForEach-Object { $_.Line }
  } catch {
    @("Player.log read failed: $($_.Exception.Message)")
  }
}

function Write-RecentEvidence {
  param([string[]]$Lines)

  if (-not $Lines -or $Lines.Count -eq 0) {
    return
  }

  Write-Host ""
  Write-Host "Recent Player.log evidence:"
  $Lines | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
}

Write-Host "Watching up to $TimeoutSec seconds for $bridgeUrl/health after game restart ..."
Write-Host "Player.log: $playerLog"

while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod -Uri "$bridgeUrl/health" -TimeoutSec 3
    Write-Host ""
    Write-Host "Bridge is up:"
    $health | ConvertTo-Json -Depth 10

    Write-Host ""
    Write-Host "Running takeover audit through MCP ..."
    Invoke-WitchMcp witch_takeover_audit @{
      bridgeTimeoutMs = 5000
      bridgePollMs = 250
      includeScreenshot = [bool]$IncludeScreenshot
    }
    exit 0
  } catch {
    $lastError = $_.Exception.Message
  }

  $evidence = @(Get-LogEvidence -Last $TailLines)
  $evidenceText = $evidence -join "`n"
  if ($evidenceText -and $evidenceText -ne $lastEvidenceText) {
    Write-RecentEvidence $evidence
    $lastEvidenceText = $evidenceText
  }

  Start-Sleep -Seconds $IntervalSec
}

Write-Host ""
Write-Host "Timed out waiting for the bridge."

$finalEvidence = @(Get-LogEvidence -Last $TailLines)
if (-not (Test-Path -LiteralPath $playerLog)) {
  Write-Host "Classification: Player.log was not found, so the game may not have started far enough to write logs."
} elseif (-not (($finalEvidence -join "`n") -match "CodexMcpBridge")) {
  Write-Host "Classification: no CodexMcpBridge evidence was found in Player.log; the mod was likely not discovered or loaded."
} else {
  Write-Host "Classification: CodexMcpBridge evidence exists, but the bridge endpoint stayed closed; inspect the evidence for bridge startup errors."
}

Write-RecentEvidence $finalEvidence

Write-Host ""
Write-Host "Running full diagnostics for a static evidence bundle ..."
powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "diagnose-runtime.ps1")

Write-Error "Timed out waiting for the bridge after restart. Last error: $lastError"
