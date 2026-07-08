$ErrorActionPreference = "Stop"

$root = if ([string]::IsNullOrWhiteSpace($env:WITCH_JOURNEY_GAME_ROOT)) {
  Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
} else {
  Resolve-Path $env:WITCH_JOURNEY_GAME_ROOT
}
$managed = Join-Path $root "Witch's Apocalyptic Journey_Data\Managed"
$source = Join-Path $root "Witch's Apocalyptic Journey_Data\Mods\CodexMcpBridge\Dev\Entry.cs"
$outDir = Join-Path $root "Witch's Apocalyptic Journey_Data\Mods\CodexMcpBridge\Scripts"
$outDll = Join-Path $outDir "Entry.dll"
$buildDir = Join-Path $PSScriptRoot "..\build"
$buildDll = Join-Path $buildDir "CodexMcpBridge.Codex.dll"
$mirrorOutDir = Join-Path $root "Mods\CodexMcpBridge\Scripts"
$mirrorDll = Join-Path $mirrorOutDir "Entry.dll"

New-Item -ItemType Directory -Force $outDir | Out-Null
New-Item -ItemType Directory -Force $buildDir | Out-Null
New-Item -ItemType Directory -Force $mirrorOutDir | Out-Null

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

  Copy-Item -LiteralPath $buildDll -Destination $outDll -Force
  Copy-Item -LiteralPath $outDll -Destination $mirrorDll -Force
  Copy-Item -LiteralPath $source -Destination (Join-Path $root "Mods\CodexMcpBridge\Dev\Entry.cs") -Force
  Write-Host "Built $outDll"
  Write-Host "Mirrored $mirrorDll"
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

Copy-Item -LiteralPath $buildDll -Destination $outDll -Force
Copy-Item -LiteralPath $outDll -Destination $mirrorDll -Force
Copy-Item -LiteralPath $source -Destination (Join-Path $root "Mods\CodexMcpBridge\Dev\Entry.cs") -Force

Write-Host "Built $outDll"
Write-Host "Mirrored $mirrorDll"
