$ErrorActionPreference = "Stop"

function Invoke-WitchMcpJson {
  param(
    [Parameter(Mandatory = $true)][string]$Tool,
    [hashtable]$Arguments = @{}
  )

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("witch-mcp-args-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    $Arguments | ConvertTo-Json -Depth 30 -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
    $raw = python (Join-Path $PSScriptRoot "mcp-call.py") $Tool "@$tmp"
    $message = ($raw | Out-String) | ConvertFrom-Json
    if ($message.error) {
      throw ($Tool + " returned MCP error: " + ($message.error.message | Out-String))
    }
    return ($message.result.content[0].text | ConvertFrom-Json)
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
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
      throw ($Message + ": " + ($Evidence | ConvertTo-Json -Depth 30 -Compress))
    }
    throw $Message
  }
}

Write-Host "Checking direct witch_input_mouse refusal..."
$direct = Invoke-WitchMcpJson witch_input_mouse @{ action = "click"; x = 10; y = 10 }
Assert-Field ($direct.ok -eq $false) "witch_input_mouse unexpectedly succeeded" $direct
Assert-Field ($direct.reason -eq "mouse_forbidden") "witch_input_mouse did not report mouse_forbidden" $direct

Write-Host "Checking bridge escape-hatch input.mouse refusal..."
$escape = Invoke-WitchMcpJson witch_bridge_command @{ command = "input.mouse"; params = @{ action = "click"; x = 10; y = 10 } }
Assert-Field ($escape.ok -eq $false) "witch_bridge_command input.mouse unexpectedly succeeded" $escape
Assert-Field ($escape.reason -eq "mouse_forbidden") "witch_bridge_command input.mouse did not report mouse_forbidden" $escape

Write-Host "Checking batch mouse refusal..."
$batch = Invoke-WitchMcpJson witch_batch @{
  dryRun = $false
  steps = @(
    @{ tool = "witch_input_mouse"; arguments = @{ action = "click"; x = 10; y = 10 } }
  )
}
Assert-Field ($batch.ok -eq $false) "witch_batch with mouse unexpectedly succeeded" $batch
Assert-Field ($batch.results[0].result.reason -eq "mouse_forbidden") "witch_batch did not preserve mouse_forbidden result" $batch

Write-Host "Checking capability advertises no-mouse mode..."
$capabilities = Invoke-WitchMcpJson witch_capabilities
Assert-Field ($capabilities.noMouseDefault -eq $true) "witch_capabilities did not advertise noMouseDefault=true" $capabilities
Assert-Field ($capabilities.noMouseMode.enabledByDefault -eq $true) "witch_capabilities noMouseMode was not enabled by default" $capabilities
Assert-Field (@($capabilities.noMouseMode.forbiddenCommands) -contains "input.mouse") "witch_capabilities did not list input.mouse as forbidden" $capabilities

Write-Host "Checking no-mouse audit coverage..."
$audit = Invoke-WitchMcpJson witch_no_mouse_audit @{ includeCurrentState = $true; includePolicyTests = $true }
Assert-Field ($audit.ok -eq $true) "witch_no_mouse_audit did not return ok=true" $audit
Assert-Field ($audit.policyTests.ok -eq $true) "witch_no_mouse_audit policy tests failed" $audit
Assert-Field ($audit.checks | Where-Object { $_.name -eq "default_no_mouse_enabled" -and $_.ok -eq $true }) "witch_no_mouse_audit did not confirm default no-mouse mode" $audit
Assert-Field ($audit.operationFamilies | Where-Object { $_.name -eq "high_level_gameplay" -and $_.noMouse -eq $true }) "witch_no_mouse_audit did not report high-level gameplay as no-mouse" $audit
Assert-Field ($audit.operationFamilies | Where-Object { $_.name -eq "ui_operations" -and $_.noMouse -eq $true }) "witch_no_mouse_audit did not report UI operations as no-mouse" $audit
Assert-Field ($audit.operationFamilies | Where-Object { $_.name -eq "scene_operations" -and $_.noMouse -eq $true }) "witch_no_mouse_audit did not report scene operations as no-mouse" $audit
Assert-Field ($audit.operationFamilies | Where-Object { $_.name -eq "battle_card_operations" -and $_.noMouse -eq $true }) "witch_no_mouse_audit did not report battle card operations as no-mouse" $audit

Write-Host "Checking current control map uses no-mouse calls..."
$controlMap = Invoke-WitchMcpJson witch_control_map @{ includeHidden = $false; onlyInteractive = $true }
Assert-Field ($controlMap.ok -eq $true) "witch_control_map did not return ok=true" $controlMap
Assert-Field ($controlMap.noMouseDefault -eq $true) "witch_control_map did not advertise noMouseDefault=true" $controlMap
$mouseMapped = @($controlMap.operations | Where-Object { $_.noMouse -ne $true -or $_.call.tool -eq "witch_input_mouse" })
Assert-Field ($mouseMapped.Count -eq 0) "witch_control_map exposed a mouse-based operation" $controlMap

Write-Host "Checking live no-mouse coverage matrix..."
$coverage = Invoke-WitchMcpJson witch_no_mouse_coverage @{ includeCurrentState = $true; includePolicyTests = $true }
Assert-Field ($coverage.ok -eq $true) "witch_no_mouse_coverage did not return ok=true" $coverage
Assert-Field ($coverage.checks | Where-Object { $_.name -eq "runtime_services_present" -and $_.ok -eq $true }) "witch_no_mouse_coverage did not confirm runtime services" $coverage
Assert-Field ($coverage.families | Where-Object { $_.name -eq "high_level_gameplay" -and $_.runtime.ok -eq $true }) "witch_no_mouse_coverage did not confirm gameplay automation" $coverage
Assert-Field ($coverage.families | Where-Object { $_.name -eq "ui_operations" -and $_.runtime.ok -eq $true }) "witch_no_mouse_coverage did not confirm UI automation" $coverage
Assert-Field ($coverage.families | Where-Object { $_.name -eq "scene_operations" -and $_.runtime.ok -eq $true }) "witch_no_mouse_coverage did not confirm scene automation" $coverage
Assert-Field ($coverage.families | Where-Object { $_.name -eq "battle_card_operations" -and $_.runtime.ok -eq $true }) "witch_no_mouse_coverage did not confirm battle automation" $coverage

Write-Host "ok: no-mouse policy refuses OS mouse entry points"
