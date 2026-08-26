param(
    [int]$StartupTimeoutSeconds = 20
)

$ErrorActionPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
. (Join-Path $PSScriptRoot "kiosk-presence.ps1")

$paths = Get-ArtemRuntimePaths

# Lifecycle policy lives in the shared watcher loop (see kiosk-presence.ps1):
# explicit stop requests close the dedicated kiosk promptly; advisory presence
# loss is tolerated over a bounded grace window and then exits non-destructively.
Invoke-ArtemKioskWatcherLoop `
    -Paths $paths `
    -StartupTimeoutSeconds $StartupTimeoutSeconds | Out-Null

exit 0
