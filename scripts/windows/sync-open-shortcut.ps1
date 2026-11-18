param(
    [Parameter(Mandatory)][string]$Desktop,
    [Parameter(Mandatory)][string]$Documents
)
$ErrorActionPreference = "Stop"
$linkPath = Join-Path $Desktop "Open Control Center.lnk"
$legacyTarget = Join-Path $Documents "Open Control Center.cmd"
$guiHost = Join-Path $env:SystemRoot "System32\wscript.exe"
$launcher = Join-Path $PSScriptRoot "open-panel.wsf"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Panel GUI launcher is missing" }
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
if (Test-Path -LiteralPath $linkPath) {
    # Upgrade only the known, argument-free helper. Preserve customized shortcuts.
    if ($link.TargetPath -ne $legacyTarget -or -not [string]::IsNullOrWhiteSpace($link.Arguments)) { return }
}
$link.TargetPath = $guiHost
$link.Arguments = '//nologo "' + $launcher + '"'
$link.WorkingDirectory = $PSScriptRoot
$link.Save()
