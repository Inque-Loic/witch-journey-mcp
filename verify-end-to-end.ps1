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
      throw ($Tool + " returned MCP error: " + ($message.error.message | Out-String))
    }
    $text = $message.result.content[0].text
    return ($text | ConvertFrom-Json)
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Assert-WitchOk {
  param(
    [Parameter(Mandatory = $true)]$Result,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($Result.ok -ne $true) {
    throw ($Name + " did not return ok=true: " + ($Result | ConvertTo-Json -Depth 20 -Compress))
  }
}

function Assert-Field {
  param(
    [Parameter(Mandatory = $true)]$Condition,
    [Parameter(Mandatory = $true)][string]$Message,
    $Evidence = $null
  )

  if (-not $Condition) {
    if ($null -ne $Evidence) {
      throw ($Message + ": " + ($Evidence | ConvertTo-Json -Depth 20 -Compress))
    }
    throw $Message
  }
}

function Invoke-CheckedScript {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  powershell -ExecutionPolicy Bypass -File $Path
  if ($LASTEXITCODE -ne 0) {
    throw ("Script failed with exit code " + $LASTEXITCODE + ": " + $Path)
  }
}

$allowFakeNoProcessAudit = $env:WITCH_E2E_ALLOW_FAKE_NO_PROCESS -eq "1"

Write-Host "1. Checking in-game bridge..."
Invoke-CheckedScript (Join-Path $PSScriptRoot "check-bridge.ps1")

Write-Host "2. Calling witch_status through MCP..."
$status = Invoke-WitchMcpJson witch_status
Assert-WitchOk $status "witch_status"

Write-Host "3. Calling witch_wait_bridge through MCP..."
$waitBridge = Invoke-WitchMcpJson witch_wait_bridge @{ timeoutMs = 5000; pollMs = 250 }
Assert-WitchOk $waitBridge "witch_wait_bridge"

Write-Host "4. Calling witch_watch_bridge_load through MCP..."
$watch = Invoke-WitchMcpJson witch_watch_bridge_load @{ timeoutMs = 5000; pollMs = 250; runAuditWhenReady = $true; includeScreenshot = $false }
Assert-WitchOk $watch "witch_watch_bridge_load"

Write-Host "5. Calling witch_restart_and_watch_bridge confirmation refusal through MCP..."
$restartDenied = Invoke-WitchMcpJson witch_restart_and_watch_bridge @{ timeoutMs = 5000; pollMs = 250 }
Assert-Field ($restartDenied.reason -eq "restart_confirmation_required") "witch_restart_and_watch_bridge did not require restart confirmation" $restartDenied

Write-Host "6. Calling witch_capabilities through MCP..."
$capabilities = Invoke-WitchMcpJson witch_capabilities
Assert-WitchOk $capabilities "witch_capabilities"
Assert-Field (@($capabilities.tools).Count -ge 48) "witch_capabilities returned too few tools" $capabilities

Write-Host "7. Calling witch_runtime_diagnostics through MCP..."
$diagnostics = Invoke-WitchMcpJson witch_runtime_diagnostics @{ includeLogTail = $false }
Assert-WitchOk $diagnostics "witch_runtime_diagnostics"
Assert-Field ($diagnostics.bridgeStatus.ok -eq $true) "witch_runtime_diagnostics bridgeStatus is not online" $diagnostics

Write-Host "8. Calling witch_prepare_takeover through MCP..."
$prepare = Invoke-WitchMcpJson witch_prepare_takeover @{ launchIfNotRunning = $false; bridgeTimeoutMs = 5000; bridgePollMs = 250; includeScreenshot = $false }
Assert-WitchOk $prepare "witch_prepare_takeover"

Write-Host "9. Calling witch_takeover_audit through MCP..."
$audit = Invoke-WitchMcpJson witch_takeover_audit @{ bridgeTimeoutMs = 5000; bridgePollMs = 250; includeScreenshot = $false }
if ($allowFakeNoProcessAudit -and $audit.ok -ne $true) {
  $gameProcessRequirement = @($audit.requirements | Where-Object { $_.name -eq "game_process" })[0]
  Assert-Field ($audit.reason -eq "requirements_not_met") "witch_takeover_audit fake-mode failure reason was not requirements_not_met" $audit
  Assert-Field ($gameProcessRequirement.ok -eq $false) "witch_takeover_audit fake-mode failure was not caused by the missing game process" $audit
} else {
  Assert-WitchOk $audit "witch_takeover_audit"
}

Write-Host "10. Calling witch_runtime_inspect through MCP..."
$runtimeInspect = Invoke-WitchMcpJson witch_runtime_inspect @{ query = "RuntimeGameplayAutomationService"; assembly = "Witch"; maxTypes = 10; maxMembersPerType = 20 }
Assert-WitchOk $runtimeInspect "witch_runtime_inspect"

Write-Host "11. Calling witch_runtime_objects through MCP..."
$runtimeObjects = Invoke-WitchMcpJson witch_runtime_objects @{ query = "Camera"; componentType = "Camera"; maxObjects = 10 }
Assert-WitchOk $runtimeObjects "witch_runtime_objects"

Write-Host "12. Calling witch_runtime_object_detail through MCP..."
$runtimeObjectDetail = Invoke-WitchMcpJson witch_runtime_object_detail @{ query = "Camera"; componentType = "Camera"; maxMembersPerComponent = 20 }
Assert-WitchOk $runtimeObjectDetail "witch_runtime_object_detail"

Write-Host "13. Calling witch_runtime_component_members through MCP..."
$runtimeComponentMembers = Invoke-WitchMcpJson witch_runtime_component_members @{ query = "Camera"; componentType = "Camera"; memberQuery = "field"; includeValues = $false; maxMembersPerComponent = 30 }
Assert-WitchOk $runtimeComponentMembers "witch_runtime_component_members"

Write-Host "14. Calling witch_runtime_component_call dry run through MCP..."
$componentCall = Invoke-WitchMcpJson witch_runtime_component_call @{ query = "Camera"; componentType = "Camera"; methodName = "GetInstanceID"; dryRun = $true }
Assert-WitchOk $componentCall "witch_runtime_component_call"
Assert-Field ($componentCall.data.dryRun -ne $false) "witch_runtime_component_call did not remain dry-run" $componentCall

Write-Host "15. Calling witch_runtime_component_set dry run through MCP..."
$componentSet = Invoke-WitchMcpJson witch_runtime_component_set @{ query = "Camera"; componentType = "Camera"; memberName = "fieldOfView"; value = 60; dryRun = $true }
Assert-WitchOk $componentSet "witch_runtime_component_set"
Assert-Field ($componentSet.data.dryRun -ne $false) "witch_runtime_component_set did not remain dry-run" $componentSet

Write-Host "16. Calling witch_verify_readiness through MCP..."
$readiness = Invoke-WitchMcpJson witch_verify_readiness @{ bridgeTimeoutMs = 5000; bridgePollMs = 250; includeScreenshot = $true; screenshotTimeoutMs = 5000; screenshotPollMs = 100 }
Assert-WitchOk $readiness "witch_verify_readiness"

Write-Host "17. Calling witch_game_snapshot through MCP..."
$snapshot = Invoke-WitchMcpJson witch_game_snapshot @{ includeHidden = $false; onlyInteractive = $true }
Assert-WitchOk $snapshot "witch_game_snapshot"

Write-Host "18. Calling witch_control_map through MCP..."
$controlMap = Invoke-WitchMcpJson witch_control_map @{ includeHidden = $false; onlyInteractive = $true }
Assert-WitchOk $controlMap "witch_control_map"
$mouseMapped = @($controlMap.operations | Where-Object { $_.noMouse -ne $true -or $_.call.tool -eq "witch_input_mouse" })
Assert-Field ($mouseMapped.Count -eq 0) "witch_control_map exposed a mouse-based operation" $controlMap

Write-Host "19. Calling witch_state_summary through MCP..."
$summary = Invoke-WitchMcpJson witch_state_summary @{ includeHidden = $false; onlyInteractive = $true }
Assert-WitchOk $summary "witch_state_summary"

Write-Host "20. Calling witch_plan_next through MCP..."
$plan = Invoke-WitchMcpJson witch_plan_next @{ includeHidden = $false; onlyInteractive = $true }
Assert-Field ($plan.ok -eq $true -or $plan.strategy -eq "observe") "witch_plan_next returned neither ok plan nor observe fallback" $plan

Write-Host "21. Calling witch_execute_plan dry run through MCP..."
$executePlan = Invoke-WitchMcpJson witch_execute_plan @{ dryRun = $true; includePostSummary = $false }
Assert-WitchOk $executePlan "witch_execute_plan dry run"
Assert-Field ($executePlan.dryRun -eq $true) "witch_execute_plan did not remain dry-run" $executePlan

Write-Host "22. Calling witch_takeover_step dry run through MCP..."
$takeoverStep = Invoke-WitchMcpJson witch_takeover_step @{ dryRun = $true; includeScreenshot = $true; includePostSummary = $false; bridgeTimeoutMs = 5000; bridgePollMs = 250; screenshotTimeoutMs = 5000; screenshotPollMs = 100 }
Assert-WitchOk $takeoverStep "witch_takeover_step dry run"
Assert-Field ($takeoverStep.dryRun -eq $true) "witch_takeover_step did not remain dry-run" $takeoverStep

Write-Host "23. Calling witch_takeover_drive dry run through MCP..."
$takeoverDrive = Invoke-WitchMcpJson witch_takeover_drive @{ dryRun = $true; maxSteps = 3; includeScreenshot = $false; includePostSummary = $false; bridgeTimeoutMs = 5000; bridgePollMs = 250 }
Assert-WitchOk $takeoverDrive "witch_takeover_drive dry run"
Assert-Field ($takeoverDrive.dryRun -eq $true) "witch_takeover_drive did not remain dry-run" $takeoverDrive

Write-Host "24. Calling witch_find_targets through MCP..."
$targets = Invoke-WitchMcpJson witch_find_targets @{ query = ""; maxResults = 10 }
Assert-WitchOk $targets "witch_find_targets"

Write-Host "25. Calling witch_batch dry run through MCP..."
$batch = Invoke-WitchMcpJson witch_batch @{
  dryRun = $true
  steps = @(
    @{ tool = "witch_state_summary"; arguments = @{ includeHidden = $false; onlyInteractive = $true } }
    @{ tool = "witch_plan_next"; arguments = @{ includeHidden = $false; onlyInteractive = $true } }
    @{ tool = "witch_execute_plan"; arguments = @{ dryRun = $true; includePostSummary = $false } }
  )
}
Assert-WitchOk $batch "witch_batch dry run"

Write-Host "26. Calling witch_ui_snapshot through MCP..."
$uiSnapshot = Invoke-WitchMcpJson witch_ui_snapshot @{ includeHidden = $false }
Assert-WitchOk $uiSnapshot "witch_ui_snapshot"

Write-Host "27. Calling witch_scene_snapshot through MCP..."
$sceneSnapshot = Invoke-WitchMcpJson witch_scene_snapshot @{ onlyInteractive = $true }
Assert-WitchOk $sceneSnapshot "witch_scene_snapshot"

Write-Host "28. Calling witch_screen_info through MCP..."
$screenInfo = Invoke-WitchMcpJson witch_screen_info
Assert-WitchOk $screenInfo "witch_screen_info"

Write-Host "29. Calling witch_screen_capture_wait through MCP..."
$screenCapture = Invoke-WitchMcpJson witch_screen_capture_wait @{ timeoutMs = 5000; pollMs = 100 }
Assert-WitchOk $screenCapture "witch_screen_capture_wait"
Assert-Field ($screenCapture.sizeBytes -gt 0) "witch_screen_capture_wait did not produce a non-empty file" $screenCapture

Write-Host "30. Calling witch_window_focus through MCP..."
$focus = Invoke-WitchMcpJson witch_window_focus
Assert-WitchOk $focus "witch_window_focus"

Write-Host "31. Calling witch_legal_actions through MCP..."
$legalActions = Invoke-WitchMcpJson witch_legal_actions
Assert-WitchOk $legalActions "witch_legal_actions"

Write-Host "32. Calling witch_auto_step dry run through MCP..."
$autoStep = Invoke-WitchMcpJson witch_auto_step @{ dryRun = $true; includeLegalActions = $true }
if ($autoStep.ok -eq $true) {
  Assert-Field ($autoStep.dryRun -eq $true) "witch_auto_step did not remain dry-run" $autoStep
} else {
  Assert-Field ($autoStep.reason -eq "no_legal_actions") "witch_auto_step dry run failed for a reason other than no_legal_actions" $autoStep
  Assert-Field ($autoStep.legalActions.ok -eq $true) "witch_auto_step no_legal_actions did not include a successful legal-action snapshot" $autoStep
}

Write-Host "33. Verifying action policy denial through MCP..."
Invoke-CheckedScript (Join-Path $PSScriptRoot "verify-action-policy.ps1")

Write-Host "34. Verifying no-mouse policy through MCP..."
Invoke-CheckedScript (Join-Path $PSScriptRoot "verify-no-mouse-policy.ps1")

Write-Host "ok: bridge and MCP tool path responded"
