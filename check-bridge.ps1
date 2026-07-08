$ErrorActionPreference = "Stop"

$bridgeUrl = $env:WITCH_JOURNEY_BRIDGE_URL
if ([string]::IsNullOrWhiteSpace($bridgeUrl)) {
  $bridgeUrl = "http://127.0.0.1:18171"
}

Write-Host "Checking $bridgeUrl/health ..."
try {
  $health = Invoke-RestMethod -Uri "$bridgeUrl/health" -TimeoutSec 3
  $health | ConvertTo-Json -Depth 10

  Write-Host "Checking $bridgeUrl/command status ..."
  $status = Invoke-RestMethod `
    -Uri "$bridgeUrl/command" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{ command = "status"; params = @{} } | ConvertTo-Json -Compress) `
    -TimeoutSec 5
  $status | ConvertTo-Json -Depth 10
} catch {
  Write-Error "Bridge is not reachable. Start or restart Witch's Apocalyptic Journey so CodexMcpBridge can load. $($_.Exception.Message)"
}
