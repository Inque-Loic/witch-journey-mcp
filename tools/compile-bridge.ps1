$ErrorActionPreference = "Stop"

$root = if ([string]::IsNullOrWhiteSpace($env:WITCH_JOURNEY_GAME_ROOT)) {
  Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
} else {
  Resolve-Path $env:WITCH_JOURNEY_GAME_ROOT
}
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$managed = Join-Path $root "Witch's Apocalyptic Journey_Data\Managed"
$repoSource = Join-Path $repoRoot "bridge-mod\Dev\Entry.cs"
$installedSource = Join-Path $root "Witch's Apocalyptic Journey_Data\Mods\CodexMcpBridge\Dev\Entry.cs"
$source = if (Test-Path $repoSource) { $repoSource } else { $installedSource }
$outDir = Join-Path $root "Witch's Apocalyptic Journey_Data\Mods\CodexMcpBridge\Scripts"
$outDll = Join-Path $outDir "Entry.dll"
$buildDir = Join-Path $PSScriptRoot "..\build"
$buildDll = Join-Path $buildDir "CodexMcpBridge.Codex.dll"
$repoOutDir = Join-Path $repoRoot "bridge-mod\Scripts"
$repoDll = Join-Path $repoOutDir "Entry.dll"
$mirrorOutDir = Join-Path $root "Mods\CodexMcpBridge\Scripts"
$mirrorDll = Join-Path $mirrorOutDir "Entry.dll"
$mirrorDevDir = Join-Path $root "Mods\CodexMcpBridge\Dev"
$mirrorSource = Join-Path $mirrorDevDir "Entry.cs"
$installedDevDir = Join-Path $root "Witch's Apocalyptic Journey_Data\Mods\CodexMcpBridge\Dev"

New-Item -ItemType Directory -Force $outDir | Out-Null
New-Item -ItemType Directory -Force $buildDir | Out-Null
New-Item -ItemType Directory -Force $repoOutDir | Out-Null
New-Item -ItemType Directory -Force $mirrorOutDir | Out-Null
New-Item -ItemType Directory -Force $mirrorDevDir | Out-Null
New-Item -ItemType Directory -Force $installedDevDir | Out-Null

function Copy-BridgeArtifact {
  param(
    [Parameter(Mandatory = $true)][string]$From,
    [Parameter(Mandatory = $true)][string]$To,
    [switch]$Optional
  )

  try {
    Copy-Item -LiteralPath $From -Destination $To -Force
    return $true
  } catch {
    if ($Optional) {
      Write-Warning ("Could not update " + $To + ": " + $_.Exception.Message)
      return $false
    }
    throw
  }
}

$refs = @(
  "mscorlib.dll",
  "System.dll",
  "System.Core.dll",
  "netstandard.dll",
  "System.Net.Http.dll",
  "Newtonsoft.Json.dll",
  "UnityEngine.dll",
  "UnityEngine.CoreModule.dll",
  "Witch.dll",
  "Witch.Core.dll"
) | ForEach-Object { Join-Path $managed $_ }

$candidateCsc = @(
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($candidateCsc) {
  $refArgs = $refs | ForEach-Object { "/reference:$_" }
  $args = @(
    "/target:library",
    "/nologo",
    "/optimize+",
    "/langversion:latest",
    "/out:$buildDll"
  ) + $refArgs + @($source)

  & $candidateCsc @args
  if ($LASTEXITCODE -ne 0) {
    throw "csc failed with exit code $LASTEXITCODE"
  }

  $repoUpdated = Copy-BridgeArtifact -From $buildDll -To $repoDll
  $mirrorUpdated = Copy-BridgeArtifact -From $buildDll -To $mirrorDll -Optional
  Copy-BridgeArtifact -From $source -To $mirrorSource -Optional | Out-Null
  $installedUpdated = Copy-BridgeArtifact -From $buildDll -To $outDll -Optional
  Copy-BridgeArtifact -From $source -To $installedSource -Optional | Out-Null
  Write-Host ("Built repo DLL " + $repoDll + " [" + ($(if ($repoUpdated) { "updated" } else { "failed" })) + "]")
  Write-Host ("Mirrored DLL " + $mirrorDll + " [" + ($(if ($mirrorUpdated) { "updated" } else { "locked-or-skipped" })) + "]")
  Write-Host ("Installed Data DLL " + $outDll + " [" + ($(if ($installedUpdated) { "updated" } else { "locked-or-skipped" })) + "]")
  exit 0
}

$compilerRefs = @(
  "Microsoft.CodeAnalysis.dll",
  "Microsoft.CodeAnalysis.CSharp.dll",
  "System.Collections.Immutable.dll",
  "System.Memory.dll",
  "System.Runtime.CompilerServices.Unsafe.dll",
  "System.Reflection.Metadata.dll"
) | ForEach-Object { Join-Path $managed $_ }

[AppDomain]::CurrentDomain.add_AssemblyResolve({
  param($sender, $args)
  $name = [System.Reflection.AssemblyName]::new($args.Name)
  $path = Join-Path $managed ($name.Name + ".dll")
  if (Test-Path $path) {
    return [System.Reflection.Assembly]::LoadFrom($path)
  }
  return $null
}) | Out-Null

try {
  foreach ($compilerRef in $compilerRefs) {
    Add-Type -Path $compilerRef
  }
} catch [System.Reflection.ReflectionTypeLoadException] {
  $_.Exception.LoaderExceptions | ForEach-Object { Write-Error $_.Message }
  throw
}

$code = Get-Content -Raw -LiteralPath $source
$syntaxTree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($code)
$metadataRefs = New-Object 'System.Collections.Generic.List[Microsoft.CodeAnalysis.MetadataReference]'
foreach ($ref in $refs) {
  if (-not (Test-Path $ref)) {
    throw "Missing reference: $ref"
  }
  $metadataRefs.Add([Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile($ref))
}

$options = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new(
  [Microsoft.CodeAnalysis.OutputKind]::DynamicallyLinkedLibrary
).WithOptimizationLevel([Microsoft.CodeAnalysis.OptimizationLevel]::Release)

$compilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create(
  "CodexMcpBridge.Codex",
  [Microsoft.CodeAnalysis.SyntaxTree[]]@($syntaxTree),
  $metadataRefs,
  $options
)

$stream = [System.IO.File]::Open($buildDll, [System.IO.FileMode]::Create)
try {
  $result = $compilation.Emit($stream)
} finally {
  $stream.Dispose()
}

if (-not $result.Success) {
  $result.Diagnostics | ForEach-Object { Write-Error $_.ToString() }
  throw "Compilation failed"
}

$repoUpdated = Copy-BridgeArtifact -From $buildDll -To $repoDll
$mirrorUpdated = Copy-BridgeArtifact -From $buildDll -To $mirrorDll -Optional
Copy-BridgeArtifact -From $source -To $mirrorSource -Optional | Out-Null
$installedUpdated = Copy-BridgeArtifact -From $buildDll -To $outDll -Optional
Copy-BridgeArtifact -From $source -To $installedSource -Optional | Out-Null

Write-Host ("Built repo DLL " + $repoDll + " [" + ($(if ($repoUpdated) { "updated" } else { "failed" })) + "]")
Write-Host ("Mirrored DLL " + $mirrorDll + " [" + ($(if ($mirrorUpdated) { "updated" } else { "locked-or-skipped" })) + "]")
Write-Host ("Installed Data DLL " + $outDll + " [" + ($(if ($installedUpdated) { "updated" } else { "locked-or-skipped" })) + "]")
