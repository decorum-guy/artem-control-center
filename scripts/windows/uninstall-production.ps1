param(
    [switch]$RemoveRuntimeData
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
Stop-ArtemRuntime -Paths $paths -Manual $true

$taskName = "Artem Control Center Runtime"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$desktop = [Environment]::GetFolderPath("Desktop")
@(
    "Start Control Center.cmd",
    "Open Control Center.cmd",
    "Stop Control Center.cmd",
    "Update Control Center.cmd",
    "Control Center Status.cmd"
) | ForEach-Object {
    Remove-Item -LiteralPath (Join-Path $desktop $_) -Force -ErrorAction SilentlyContinue
}

if ($RemoveRuntimeData) {
    Remove-Item -LiteralPath $paths.RuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Production runtime, task, shortcuts and local runtime data removed."
}
else {
    Write-Host "Production runtime, task and shortcuts removed."
    Write-Host "Local configuration and logs were preserved at: $($paths.RuntimeRoot)"
}
