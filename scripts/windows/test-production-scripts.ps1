$ErrorActionPreference = "Stop"

$files = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.ps1" -File |
    Where-Object { $_.Name -ne "test-production-scripts.ps1" }

foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$errors
    )
    if ($errors.Count -gt 0) {
        $messages = $errors | ForEach-Object {
            "$($file.Name):$($_.Extent.StartLineNumber): $($_.Message)"
        }
        throw ($messages -join [Environment]::NewLine)
    }
}

Write-Host "Validated $($files.Count) Windows PowerShell scripts."
