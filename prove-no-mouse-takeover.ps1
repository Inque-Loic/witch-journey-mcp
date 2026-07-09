param(
  [string]$ConfirmRestart,
  [int]$TimeoutSec = 180,
  [int]$IntervalSec = 2,
  [int]$MaxAdvanceSteps = 8,
  [int]$MaxProbesPerStep = 8,
  [string]$OutputPath,
  [switch]$ExecuteStateAdvance,
  [switch]$ExecuteProbes,
  [switch]$IncludeScreenshot
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Invoke-WitchMcpJson {
  param(
    [Parameter(Mandatory = $true)][string]$Tool,
    [hashtable]$Arguments = @{}
  )

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("witch-mcp-args-" + [guid]::NewGuid().ToString("N") + ".json")
  $out = Join-Path ([System.IO.Path]::GetTempPath()) ("witch-mcp-out-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    $Arguments | ConvertTo-Json -Depth 30 -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
    & python -X utf8 (Join-Path $PSScriptRoot "mcp-call.py") $Tool "@$tmp" > $out
    if ($LASTEXITCODE -ne 0) {
      $errorText = Get-Content -LiteralPath $out -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
      throw ("mcp-call failed for " + $Tool + ": " + $errorText)
    }
    $raw = Get-Content -LiteralPath $out -Encoding UTF8 -Raw
    $message = ($raw | Out-String) | ConvertFrom-Json
    if ($message.error) {
      throw ($message.error.message | Out-String)
    }
    return ($message.result.content[0].text | ConvertFrom-Json)
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  }
}

function Format-Missing {
  param($Audit)

  if (-not $Audit -or -not $Audit.missing) {
    return @()
  }

  return @($Audit.missing | ForEach-Object {
    if ($_.nextAction) {
      "- $($_.name): $($_.nextAction)"
    } else {
      "- $($_.name)"
    }
  })
}

function Write-ProofSummary {
  param($Result)

  Write-Host ""
  Write-Host "No-mouse proof result:"
  Write-Host ("  complete: " + [string]$Result.complete)
  Write-Host ("  reason:   " + [string]$Result.reason)

  $audit = $Result.completionAudit
  if (-not $audit -and $Result.preview) {
    $audit = $Result.preview.evidencePlan.audit
  }

  $missing = Format-Missing $audit
  if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Missing proof items:"
    $missing | ForEach-Object { Write-Host $_ }
  }

  $candidates = @()
  if ($Result.evidencePlan -and $Result.evidencePlan.stateAdvanceCandidates) {
    $candidates = @($Result.evidencePlan.stateAdvanceCandidates)
  } elseif ($Result.preview -and $Result.preview.stateAdvanceCandidates) {
    $candidates = @($Result.preview.stateAdvanceCandidates)
  } elseif ($Result.advanceDrive -and $Result.advanceDrive.finalPlan -and $Result.advanceDrive.finalPlan.stateAdvanceCandidates) {
    $candidates = @($Result.advanceDrive.finalPlan.stateAdvanceCandidates)
  }

  if ($candidates.Count -gt 0) {
    Write-Host ""
    Write-Host "Top no-mouse state-advance candidates:"
    $candidates | Select-Object -First 5 | ForEach-Object {
      $op = $_.operation
      Write-Host ("- score={0} family={1} action={2} label={3}" -f $_.score, $op.family, $op.action, $op.label)
      Write-Host ("  operationId: " + $op.id)
    }
  }

  if ($Result.nextStep) {
    Write-Host ""
    Write-Host ("Next step: " + $Result.nextStep)
  }
  if ($Result.recommendation) {
    Write-Host ("Recommendation: " + $Result.recommendation)
  }
}

function Get-ProofAudit {
  param($Result)

  if ($Result.completionAudit) {
    return $Result.completionAudit
  }
  if ($Result.preview -and $Result.preview.evidencePlan -and $Result.preview.evidencePlan.audit) {
    return $Result.preview.evidencePlan.audit
  }
  if ($Result.advanceDrive -and $Result.advanceDrive.finalAudit) {
    return $Result.advanceDrive.finalAudit
  }
  return $null
}

function Get-ProofPlan {
  param($Result)

  if ($Result.evidencePlan) {
    return $Result.evidencePlan
  }
  if ($Result.preview -and $Result.preview.evidencePlan) {
    return $Result.preview.evidencePlan
  }
  if ($Result.advanceDrive -and $Result.advanceDrive.finalPlan) {
    return $Result.advanceDrive.finalPlan
  }
  return $null
}

function Write-ProofBundle {
  param(
    [Parameter(Mandatory = $true)]$Result,
    [Parameter(Mandatory = $true)][string]$Mode,
    [Parameter(Mandatory = $true)][hashtable]$Arguments,
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  $audit = Get-ProofAudit $Result
  $plan = Get-ProofPlan $Result
  $bundle = [ordered]@{
    schemaVersion = 1
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    mode = $Mode
    command = "prove-no-mouse-takeover.ps1"
    arguments = $Arguments
    complete = $Result.complete -eq $true
    reason = $Result.reason
    nextStep = $Result.nextStep
    recommendation = $Result.recommendation
    missing = if ($audit -and $audit.missing) { @($audit.missing) } else { @() }
    stateAdvanceCandidates = if ($plan -and $plan.stateAdvanceCandidates) { @($plan.stateAdvanceCandidates) } else { @() }
    result = $Result
  }

  $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  $parent = Split-Path -Parent $resolved
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $bundle | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $resolved -Encoding UTF8
  Write-Host ""
  Write-Host ("Proof bundle written: " + $resolved)
  Write-Host "Proof bundles may include current game state, labels, and candidate operation ids; review before sharing."
}

$argsForTool = @{
  timeoutMs = $TimeoutSec * 1000
  pollMs = [Math]::Max(100, $IntervalSec * 1000)
  maxAdvanceSteps = $MaxAdvanceSteps
  maxProbesPerStep = $MaxProbesPerStep
  includeScreenshot = [bool]$IncludeScreenshot
  includePlan = $true
}

if ($ConfirmRestart -ne "RESTART_WITCH_GAME") {
  Write-Host "Previewing the strict no-mouse proof pipeline."
  Write-Host "No game process will be closed or restarted."
  Write-Host "To load the newest bridge DLL and run the proof pipeline, re-run with:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File .\prove-no-mouse-takeover.ps1 -ConfirmRestart RESTART_WITCH_GAME"
  Write-Host ""
  $preview = Invoke-WitchMcpJson witch_no_mouse_restart_advance_audit $argsForTool
  Write-ProofSummary $preview
  Write-ProofBundle $preview "preview" $argsForTool $OutputPath
  exit 2
}

$argsForTool.restartConfirm = "RESTART_WITCH_GAME"
$argsForTool.advanceDryRun = -not [bool]$ExecuteStateAdvance
$argsForTool.probeDryRun = -not [bool]$ExecuteProbes

if ($ExecuteStateAdvance) {
  $argsForTool.advanceConfirm = "ADVANCE_NO_MOUSE_STATE"
}
if ($ExecuteProbes) {
  $argsForTool.probeConfirm = "EXECUTE_NO_MOUSE_PROBES"
}

Write-Host "Running confirmed no-mouse proof pipeline..."
Write-Host ("  executeStateAdvance: " + [string][bool]$ExecuteStateAdvance)
Write-Host ("  executeProbes:       " + [string][bool]$ExecuteProbes)
Write-Host ""

$result = Invoke-WitchMcpJson witch_no_mouse_restart_advance_audit $argsForTool
Write-ProofSummary $result
Write-ProofBundle $result "confirmed" $argsForTool $OutputPath

if ($result.complete -eq $true) {
  exit 0
}

exit 3
