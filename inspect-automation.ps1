$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$managed = Join-Path $root "Witch's Apocalyptic Journey_Data\Managed"

[AppDomain]::CurrentDomain.add_AssemblyResolve({
  param($sender, $args)
  $name = [System.Reflection.AssemblyName]::new($args.Name)
  $candidate = Join-Path $managed ($name.Name + ".dll")
  if (Test-Path -LiteralPath $candidate) {
    return [System.Reflection.Assembly]::LoadFrom($candidate)
  }
  return $null
}) | Out-Null

$witch = [System.Reflection.Assembly]::LoadFrom((Join-Path $managed "Witch.dll"))

try {
  $allTypes = $witch.GetTypes()
} catch [System.Reflection.ReflectionTypeLoadException] {
  Write-Host "Loader exceptions:"
  $_.Exception.LoaderExceptions |
    Where-Object { $_ -ne $null } |
    Select-Object -First 20 |
    ForEach-Object { Write-Host "  $($_.Message)" }
  $allTypes = $_.Exception.Types | Where-Object { $_ -ne $null }
}

$types = $allTypes |
  Where-Object { $_.FullName -like "Witch.UI.Automation.*" } |
  Sort-Object FullName

foreach ($type in $types) {
  Write-Host ""
  Write-Host $type.FullName

  $methods = $type.GetMethods([System.Reflection.BindingFlags] "Public, Static, Instance, DeclaredOnly")
  foreach ($method in $methods) {
    $static = if ($method.IsStatic) { "static " } else { "" }
    $params = ($method.GetParameters() | ForEach-Object { "$($_.ParameterType.FullName) $($_.Name)" }) -join ", "
    Write-Host "  method: $static$($method.ReturnType.FullName) $($method.Name)($params)"
  }

  $props = $type.GetProperties([System.Reflection.BindingFlags] "Public, Instance, Static, DeclaredOnly")
  foreach ($prop in $props) {
    Write-Host "  prop:   $($prop.PropertyType.FullName) $($prop.Name)"
  }

  $fields = $type.GetFields([System.Reflection.BindingFlags] "Public, Instance, Static, DeclaredOnly")
  foreach ($field in $fields) {
    Write-Host "  field:  $($field.FieldType.FullName) $($field.Name)"
  }
}
