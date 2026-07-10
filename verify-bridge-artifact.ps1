$ErrorActionPreference = "Stop"

$root = if ([string]::IsNullOrWhiteSpace($env:WITCH_JOURNEY_GAME_ROOT)) {
  Resolve-Path (Join-Path $PSScriptRoot "..\..")
} else {
  Resolve-Path $env:WITCH_JOURNEY_GAME_ROOT
}
$dataMod = Join-Path $root "Witch's Apocalyptic Journey_Data\Mods\CodexMcpBridge"
$rootMod = Join-Path $root "Mods\CodexMcpBridge"
$source = Join-Path $dataMod "Dev\Entry.cs"
$dataDll = Join-Path $dataMod "Scripts\Entry.dll"
$rootDll = Join-Path $rootMod "Scripts\Entry.dll"
$failures = 0

function Write-Section($name) {
  Write-Host ""
  Write-Host "== $name =="
}

function Pass($message) {
  Write-Host "ok   $message"
}

function Fail($message) {
  $script:failures += 1
  Write-Host "miss $message"
}

function Test-File($path, $label) {
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path
    Pass "$label exists ($($item.Length) bytes)"
    return $true
  }
  Fail "$label missing: $path"
  return $false
}

function Test-SourcePattern($text, $pattern, $label) {
  if ($text -match $pattern) {
    Pass $label
  } else {
    Fail $label
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

function Test-DllMarker($bytes, $marker) {
  $ascii = [System.Text.Encoding]::ASCII.GetBytes($marker)
  $unicode = [System.Text.Encoding]::Unicode.GetBytes($marker)
  if ((Test-BytePattern $bytes $ascii) -or (Test-BytePattern $bytes $unicode)) {
    Pass "DLL contains marker: $marker"
  } else {
    Fail "DLL marker not found: $marker"
  }
}

function Test-Manifest($modRoot) {
  $configPath = Join-Path $modRoot "ModConfig.json"
  if (-not (Test-File $configPath "$modRoot ModConfig.json")) {
    return
  }

  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.ModName -eq "CodexMcpBridge") { Pass "$modRoot ModName matches folder" } else { Fail "$modRoot ModName expected CodexMcpBridge, got $($config.ModName)" }
    if ($config.ModAuthor -eq "Codex") { Pass "$modRoot ModAuthor = Codex" } else { Fail "$modRoot ModAuthor expected Codex, got $($config.ModAuthor)" }
    if ($config.ModVersion -eq "0.9.0") { Pass "$modRoot ModVersion = 0.9.0" } else { Fail "$modRoot ModVersion expected 0.9.0, got $($config.ModVersion)" }
    if ($config.Enabled -eq $true) { Pass "$modRoot Enabled = true" } else { Fail "$modRoot Enabled is not true" }
    if ($config.MustSame -eq $true) { Pass "$modRoot MustSame = true" } else { Fail "$modRoot MustSame is not true" }
    if (-not [string]::IsNullOrWhiteSpace($config.IconPath) -and (Test-Path -LiteralPath (Join-Path $modRoot $config.IconPath))) {
      Pass "$modRoot IconPath exists"
    } else {
      Fail "$modRoot IconPath missing or empty"
    }
  } catch {
    Fail "$configPath could not be parsed: $($_.Exception.Message)"
  }
}

Write-Section "Mod Manifests"
Test-Manifest $dataMod
Test-Manifest $rootMod

Write-Section "Script Layout"
$dataDllOk = Test-File $dataDll "data mod Entry.dll"
$rootDllOk = Test-File $rootDll "root mod Entry.dll"
Test-File $source "data mod Dev\Entry.cs" | Out-Null
Test-File (Join-Path $rootMod "Dev\Entry.cs") "root mod Dev\Entry.cs" | Out-Null

foreach ($modRoot in @($dataMod, $rootMod)) {
  $entryLua = Join-Path $modRoot "Scripts\Entry.lua"
  if (Test-Path -LiteralPath $entryLua) {
    Fail "$entryLua exists; bridge must stay DLL-only to avoid double listeners"
  } else {
    Pass "$entryLua absent (DLL-only)"
  }
}

if ($dataDllOk -and $rootDllOk) {
  $dataHash = (Get-FileHash -LiteralPath $dataDll -Algorithm SHA256).Hash
  $rootHash = (Get-FileHash -LiteralPath $rootDll -Algorithm SHA256).Hash
  if ($dataHash -eq $rootHash) {
    Pass "data/root Entry.dll hashes match"
  } else {
    Fail "data/root Entry.dll hashes differ"
  }
}

Write-Section "Assembly Metadata"
if ($dataDllOk) {
  try {
    $assemblyName = [System.Reflection.AssemblyName]::GetAssemblyName($dataDll).Name
    if ($assemblyName -eq "CodexMcpBridge.Codex") {
      Pass "assembly name = CodexMcpBridge.Codex"
    } else {
      Fail "assembly name expected CodexMcpBridge.Codex, got $assemblyName"
    }
  } catch {
    Fail "assembly name could not be read: $($_.Exception.Message)"
  }
}

Write-Section "Source Entry Shape"
if (Test-Path -LiteralPath $source) {
  $sourceText = Get-Content -LiteralPath $source -Raw
  Test-SourcePattern $sourceText '\[ModInitialize\]' "source marks an entry method with [ModInitialize]"
  Test-SourcePattern $sourceText 'public\s+static\s+void\s+Entry\s*\(\s*ModConfig\s+modConfig\s*\)' "source has template-compatible Entry(ModConfig) method"
  Test-SourcePattern $sourceText 'BridgeServer\.Start\s*\(\s*\)' "entry starts BridgeServer"
  Test-SourcePattern $sourceText 'public\s+sealed\s+class\s+BridgeRunner\s*:\s*MonoBehaviour' "source defines BridgeRunner MonoBehaviour"
  Test-SourcePattern $sourceText 'private\s+void\s+Update\s*\(\s*\)' "BridgeRunner has Update loop"
  Test-SourcePattern $sourceText 'BridgeServer\.Pump\s*\(\s*\)' "Update pumps queued bridge work"
  Test-SourcePattern $sourceText 'BridgeServer\.PumpPending\s*\(\s*\)' "Update pumps pending async work"
  Test-SourcePattern $sourceText 'confirm\s*!=\s*"CALL_WITCH_COMPONENT_METHOD"' "component method calls require confirmation when not dry-run"
  Test-SourcePattern $sourceText 'confirm\s*!=\s*"SET_WITCH_COMPONENT_MEMBER"' "component member writes require confirmation when not dry-run"
} else {
  Fail "source file missing"
}

Write-Section "DLL Capability Markers"
if ($dataDllOk) {
  $bytes = [System.IO.File]::ReadAllBytes($dataDll)
  $markers = @(
    "0.9.0",
    "ModInitializeAttribute",
    "HookAfterAttribute",
    "CodexMcpBridge",
    "CodexMcpBridgeRunner",
    "[CodexMcpBridge] listening",
    "http://127.0.0.1:18171/",
    "status",
    "ui.snapshot",
    "ui.interact",
    "ui.wait",
    "scene.snapshot",
    "scene.raycast",
    "scene.interact",
    "screen.info",
    "screen.capture",
    "window.focus",
    "input.key",
    "input.text",
    "input.mouse",
    "game.legal_actions",
    "game.perform_action",
    "battle.play_card",
    "map.place_card",
    "runtime.inspect",
    "runtime.objects",
    "runtime.object_detail",
    "runtime.component_members",
    "runtime.component_call",
    "runtime.component_set",
    "runtime.invoke_static",
    "PLACE_WITCH_MAP_CARD",
    "CALL_WITCH_COMPONENT_METHOD",
    "SET_WITCH_COMPONENT_MEMBER",
    "Witch.UI.Automation.RuntimeUiAutomationService",
    "Witch.UI.Automation.RuntimeSceneAutomationService",
    "Witch.UI.Automation.RuntimeGameplayAutomationService",
    "Witch.UI.Automation.RuntimeBattleAutomationService"
  )
  foreach ($marker in $markers) {
    Test-DllMarker $bytes $marker
  }
}

Write-Section "Result"
if ($failures -gt 0) {
  Write-Error "$failures bridge artifact checks failed."
  exit 1
}

Write-Host "Bridge artifact checks passed."
