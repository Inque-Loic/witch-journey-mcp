$ErrorActionPreference = "Stop"

$config = Join-Path $env:USERPROFILE ".codex\config.toml"
$text = Get-Content -Raw -LiteralPath $config

if ($text -notmatch '(?m)^\[mcp_servers\.witchJourney\]\s*$') {
  throw "Missing [mcp_servers.witchJourney] in $config"
}

if ($text -notmatch "(?m)^command\s*=\s*'node'\s*$") {
  throw "witchJourney command should be 'node'"
}

$expectedServer = (Resolve-Path (Join-Path $PSScriptRoot "server.mjs")).Path
$expectedEscaped = [regex]::Escape(($expectedServer -replace "\\", "\\"))

if ($text -notmatch "(?m)^args\s*=\s*\[`"$expectedEscaped`"\]\s*$") {
  throw "witchJourney args path is missing or does not point to $expectedServer"
}

if ($text -notmatch "(?m)^WITCH_JOURNEY_BRIDGE_URL\s*=\s*'http://127\.0\.0\.1:18171'\s*$") {
  throw "Missing WITCH_JOURNEY_BRIDGE_URL"
}

Write-Host "ok: witchJourney MCP config is present"
