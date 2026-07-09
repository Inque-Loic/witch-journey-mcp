$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$roots = @(
  $PSScriptRoot,
  (Join-Path $PSScriptRoot "tools")
)

$files = @()
foreach ($root in $roots) {
  if (Test-Path -LiteralPath $root) {
    $files += Get-ChildItem -LiteralPath $root -Filter "*.ps1" -File
  }
}

$failures = @()
foreach ($file in ($files | Sort-Object FullName -Unique)) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors -and $errors.Count -gt 0) {
    $failures += [pscustomobject]@{
      path = $file.FullName
      errors = @($errors | ForEach-Object {
        [pscustomobject]@{
          line = $_.Extent.StartLineNumber
          column = $_.Extent.StartColumnNumber
          message = $_.Message
        }
      })
    }
  }
}

if ($failures.Count -gt 0) {
  $failures | ConvertTo-Json -Depth 10
  throw ("PowerShell syntax check failed for " + $failures.Count + " script(s).")
}

Write-Host ("ok: PowerShell syntax for " + $files.Count + " scripts")
