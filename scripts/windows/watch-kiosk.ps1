param(
    [int]$StartupTimeoutSeconds = 20
)

$ErrorActionPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
. (Join-Path $PSScriptRoot "kiosk-presence.ps1")

$paths = Get-ArtemRuntimePaths

# Lifecycle policy lives in the shared watcher loop (see kiosk-presence.ps1):
# explicit stop requests close the dedicated kiosk promptly; advisory presence
# loss never does, so the watcher stays alive non-destructively and a later
# confirmed watcher supersedes it through kiosk-watcher-owner.json ownership.
Invoke-ArtemKioskWatcherLoop `
    -Paths $paths `
    -StartupTimeoutSeconds $StartupTimeoutSeconds | Out-Null

exit 0
