$ErrorActionPreference = "Continue"

$root = if ([string]::IsNullOrWhiteSpace($env:WITCH_JOURNEY_GAME_ROOT)) {
  Resolve-Path (Join-Path $PSScriptRoot "..\..")
} else {
  Resolve-Path $env:WITCH_JOURNEY_GAME_ROOT
}
$bridgeUrl = $env:WITCH_JOURNEY_BRIDGE_URL
if ([string]::IsNullOrWhiteSpace($bridgeUrl)) {
  $bridgeUrl = "http://127.0.0.1:18171"
}

$playerLog = Join-Path $env:USERPROFILE "AppData\LocalLow\MeowAlive\Witch's Apocalyptic Journey\Player.log"
$dataMod = Join-Path $root "Witch's Apocalyptic Journey_Data\Mods\CodexMcpBridge"
$rootMod = Join-Path $root "Mods\CodexMcpBridge"

function Write-Section($name) {
  Write-Host ""
  Write-Host "== $name =="
}

function Test-PathLine($path) {
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path
    Write-Host "ok   $path ($($item.LastWriteTime))"
  } else {
    Write-Host "miss $path"
  }
}

function Test-BytePattern($bytes, $pattern) {
  if ($null -eq $bytes -or $null -eq $pattern -or $pattern.Length -eq 0 -or $bytes.Length -lt $pattern.Length) {
    return $false
  }
  for ($i = 0; $i -le $bytes.Length - $pattern.Length; $i++) {
    $matched = $true
    for ($j = 0; $j -lt $pattern.Length; $j++) {
      if ($bytes[$i + $j] -ne $pattern[$j]) {
        $matched = $false
        break
      }
    }
    if ($matched) {
      return $true
    }
  }
  return $false
}

function Test-ModManifest($modRoot) {
  $configPath = Join-Path $modRoot "ModConfig.json"
  if (-not (Test-Path -LiteralPath $configPath)) {
    Write-Host "miss ModConfig.json: $configPath"
    return
  }

  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $requiredNonEmpty = @("ModName", "ModVersion", "ModAuthor", "ModDescription", "IconPath", "WorkshopVisibility")
    foreach ($key in $requiredNonEmpty) {
      $value = $config.$key
      if ($null -ne $value -and "$value" -ne "") {
        Write-Host "ok   $modRoot ModConfig.$key = $value"
      } else {
        Write-Host "miss $modRoot ModConfig.$key"
      }
    }
    foreach ($key in @("Dependencies", "PublishedFileId", "MustSame")) {
      if ($config.PSObject.Properties.Name -contains $key) {
        Write-Host "ok   $modRoot ModConfig.$key present"
      } else {
        Write-Host "miss $modRoot ModConfig.$key"
      }
    }
    if ($config.Enabled -eq $true) {
      Write-Host "ok   $modRoot mod is enabled"
    } else {
      Write-Host "miss $modRoot mod is not enabled"
    }
    if (-not [string]::IsNullOrWhiteSpace($config.IconPath)) {
      Test-PathLine (Join-Path $modRoot $config.IconPath)
    }
  } catch {
    Write-Host "ModConfig parse failed: $configPath $($_.Exception.Message)"
  }
}

function Test-ScriptEntryShape($modRoot) {
  $scripts = Join-Path $modRoot "Scripts"
  if (-not (Test-Path -LiteralPath $scripts)) {
    Write-Host "miss $modRoot Scripts directory"
    return
  }
  $entryDll = Join-Path $scripts "Entry.dll"
  $entryLua = Join-Path $scripts "Entry.lua"
  $disabledLua = Join-Path $scripts "Entry.lua.disabled"
  Test-PathLine $entryDll
  if (Test-Path -LiteralPath $entryLua) {
    Write-Host "warn $entryLua exists; DLL and Lua entrypoints may both load"
  } else {
    Write-Host "ok   $entryLua absent (DLL-only entry)"
  }
  if (Test-Path -LiteralPath $disabledLua) {
    Write-Host "ok   $disabledLua retained as disabled prototype"
  }
}

Write-Section "Game Process"
$processes = Get-Process | Where-Object { $_.ProcessName -like "*Witch*" } | Select-Object Id, ProcessName, StartTime, Path
if ($processes) {
  $processes | Format-List
} else {
  Write-Host "No Witch process is running."
}

Write-Section "Installed Mod Files"
Test-PathLine (Join-Path $dataMod "ModConfig.json")
Test-PathLine (Join-Path $dataMod "Scripts\Entry.dll")
Test-PathLine (Join-Path $dataMod "Dev\Entry.cs")
Test-PathLine (Join-Path $rootMod "ModConfig.json")
Test-PathLine (Join-Path $rootMod "Scripts\Entry.dll")
Test-PathLine (Join-Path $rootMod "Dev\Entry.cs")
Test-PathLine (Join-Path $dataMod "Icon.png")
Test-PathLine (Join-Path $rootMod "Icon.png")

Write-Section "Mod Manifest Evidence"
Test-ModManifest $dataMod
Test-ModManifest $rootMod

Write-Section "Script Entry Shape"
Test-ScriptEntryShape $dataMod
Test-ScriptEntryShape $rootMod

Write-Section "Bridge Artifact Verification"
try {
  powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "verify-bridge-artifact.ps1")
} catch {
  Write-Host "Bridge artifact verification failed: $($_.Exception.Message)"
}

Write-Section "Bridge DLL Capability Evidence"
$entryDll = Join-Path $dataMod "Scripts\Entry.dll"
if (Test-Path -LiteralPath $entryDll) {
  try {
    $bytes = [System.IO.File]::ReadAllBytes($entryDll)
    $markers = @("0.9.0", "screen.info", "screen.capture", "window.focus", "input.key", "input.text", "input.mouse", "CodexMcpBridgeRunner", "runtime.inspect", "runtime.objects", "runtime.object_detail", "runtime.component_members", "runtime.component_call", "runtime.component_set", "runtime.invoke_static", "map.place_card")
    foreach ($marker in $markers) {
      $asciiPattern = [System.Text.Encoding]::ASCII.GetBytes($marker)
      $unicodePattern = [System.Text.Encoding]::Unicode.GetBytes($marker)
      if ((Test-BytePattern $bytes $asciiPattern) -or (Test-BytePattern $bytes $unicodePattern)) {
        Write-Host "ok   DLL contains marker: $marker"
      } else {
        Write-Host "miss DLL marker: $marker"
      }
    }
  } catch {
    Write-Host "DLL marker scan failed: $($_.Exception.Message)"
  }
} else {
  Write-Host "DLL not found for marker scan: $entryDll"
}

Write-Section "Bridge Health"
try {
  $health = Invoke-RestMethod -Uri "$bridgeUrl/health" -TimeoutSec 3
  $health | ConvertTo-Json -Depth 10
} catch {
  Write-Host "Bridge health failed: $($_.Exception.Message)"
}

Write-Section "Bridge Status Command"
try {
  $status = Invoke-RestMethod `
    -Uri "$bridgeUrl/command" `
    -Method Post `
    -ContentType "application/json" `
    -Body (@{ command = "status"; params = @{} } | ConvertTo-Json -Compress) `
    -TimeoutSec 5
  $status | ConvertTo-Json -Depth 10
} catch {
  Write-Host "Bridge status failed: $($_.Exception.Message)"
}

Write-Section "MCP Config Launch"
try {
  python (Join-Path $PSScriptRoot "config-launch-test.py")
} catch {
  Write-Host "MCP config launch failed: $($_.Exception.Message)"
}

Write-Section "Player Log Evidence"
if (Test-Path -LiteralPath $playerLog) {
  $matches = Select-String -Path $playerLog -Pattern "CodexMcpBridge|Discovered|ModInitialize|failed to start|Exception|Mods" | Select-Object -Last 120
  if ($matches) {
    $matches | ForEach-Object { $_.Line }
  } else {
    Write-Host "No CodexMcpBridge/mod evidence found in Player.log."
  }
} else {
  Write-Host "Player.log not found: $playerLog"
}

Write-Section "Next Step"
if (-not $processes) {
  Write-Host "Start Witch's Apocalyptic Journey, then rerun this script."
} elseif (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 18171 -InformationLevel Quiet)) {
  Write-Host "The game is running but the bridge port is closed. Restart the game so CodexMcpBridge can load; if it still fails, inspect the Player Log Evidence section above."
} else {
  Write-Host "Bridge port is open. Run verify-end-to-end.ps1 for the MCP read-only verification pass."
}
