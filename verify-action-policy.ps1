$ErrorActionPreference = "Stop"

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
    $text = $message.result.content[0].text
    return ($text | ConvertFrom-Json)
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Checking legal-action policy refusal through MCP..."
$legal = Invoke-WitchMcpJson witch_legal_actions
$actions = @()
if ($legal.data.Actions) { $actions = @($legal.data.Actions) }
elseif ($legal.data.actions) { $actions = @($legal.data.actions) }
elseif ($legal.Actions) { $actions = @($legal.Actions) }
elseif ($legal.actions) { $actions = @($legal.actions) }

if ($actions.Count -lt 1) {
  throw "No legal actions are available to test policy refusal."
}

$action = $actions[0]
$actionId = $action.Id
if ([string]::IsNullOrWhiteSpace($actionId)) { $actionId = $action.id }
if ([string]::IsNullOrWhiteSpace($actionId)) {
  throw "First legal action has no Id/id."
}

$denied = Invoke-WitchMcpJson witch_auto_step @{
  dryRun = $true
  actionId = $actionId
  contains = $false
  denyActionIds = @($actionId)
  includeLegalActions = $false
}

if ($denied.ok -ne $false -or $denied.reason -ne "action_policy_denied") {
  throw ("Expected action_policy_denied but got: " + ($denied | ConvertTo-Json -Depth 20 -Compress))
}

$deniedBy = @($denied.policy.deniedBy)
if ($deniedBy -notcontains "denyActionIds") {
  throw ("Expected denyActionIds evidence but got: " + ($denied.policy | ConvertTo-Json -Depth 20 -Compress))
}

Write-Host ("ok: action policy denied legal action " + $actionId + " before execution")
