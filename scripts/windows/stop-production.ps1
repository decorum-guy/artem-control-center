param(
    [switch]$ForUpdate
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
Stop-ArtemRuntime -Paths $paths -Manual (-not $ForUpdate)

if ($ForUpdate) {
    Write-Host "Artem Control Center stopped for maintenance."
}
else {
    Write-Host "Artem Control Center fully stopped."
    Write-Host "Use the Start Control Center shortcut to run it again."
}
