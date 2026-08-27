$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$root = Join-Path ([IO.Path]::GetTempPath()) ("artem-kiosk-presence-{0}" -f [guid]::NewGuid())
$paths = [pscustomobject]@{
    RuntimeRoot = $root
    EdgeProfile = Join-Path $root "edge-profile"
    PanelUrl = "http://127.0.0.1:8787/overview"
    KioskWatchScript = Join-Path $PSScriptRoot "watch-kiosk.ps1"
}

function Write-TestPresence {
    param(
        [Parameter(Mandatory)]$Paths,
        [object]$SchemaVersion = 1,
        [string]$PageId = "0123456789abcdef01234567",
        [string]$ObservedAt = ([DateTimeOffset]::UtcNow.ToString("o"))
    )
    New-Item -ItemType Directory -Force -Path $Paths.RuntimeRoot | Out-Null
    @{
        schemaVersion = $SchemaVersion
        pageId = $PageId
        observedAt = $ObservedAt
    } | ConvertTo-Json | Set-Content -LiteralPath (Get-ArtemKioskPresencePath -Paths $Paths) -Encoding ASCII
}

try {
    New-Item -ItemType Directory -Force -Path $paths.RuntimeRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $paths.EdgeProfile | Out-Null

    if (Test-ArtemKioskPresenceRecent -Paths $paths) {
        throw "Missing presence file must not be treated as visible"
    }

    Write-TestPresence -Paths $paths
    if (-not (Test-ArtemKioskPresenceRecent -Paths $paths)) {
        throw "Fresh canonical dashboard presence must be accepted"
    }

    # Presence alone is insufficient: it must be paired with the dedicated panel
    # Edge profile. This prevents an ordinary browser tab from impersonating kiosk.
    function Test-ArtemKioskRunning { return $false }
    if (Test-ArtemKioskVisible -Paths $paths) {
        throw "Fresh heartbeat without panel-owned Edge must not count as kiosk"
    }

    # A live panel profile plus fresh heartbeat is enough even when a legacy
    # narrow visibility probe is unavailable on Samsung.
    function Test-ArtemKioskRunning { return $true }
    if (-not (Test-ArtemKioskVisible -Paths $paths)) {
        throw "Fresh application presence plus panel Edge must be kiosk authority"
    }

    Write-TestPresence -Paths $paths -ObservedAt ([DateTimeOffset]::UtcNow.AddSeconds(-30).ToString("o"))
    if (Test-ArtemKioskPresenceRecent -Paths $paths) {
        throw "Stale dashboard presence must not be accepted"
    }

    Write-TestPresence -Paths $paths -ObservedAt ([DateTimeOffset]::UtcNow.AddSeconds(30).ToString("o"))
    if (Test-ArtemKioskPresenceRecent -Paths $paths) {
        throw "Future dashboard presence must not be accepted"
    }

    foreach ($case in @(
        @{ schema = 2; page = "0123456789abcdef01234567"; time = [DateTimeOffset]::UtcNow.ToString("o") },
        @{ schema = 1; page = "bad-page"; time = [DateTimeOffset]::UtcNow.ToString("o") },
        @{ schema = 1; page = "0123456789abcdef01234567"; time = "not-a-time" }
    )) {
        Write-TestPresence -Paths $paths -SchemaVersion $case.schema -PageId $case.page -ObservedAt $case.time
        if (Test-ArtemKioskPresenceRecent -Paths $paths) {
            throw "Malformed dashboard presence must fail closed"
        }
    }

    # Exercise the timeout distinction without launching Edge. The updater owns a
    # healthy software transaction, so kiosk absence is a warning/recovery state,
    # never a reason to roll back the validated checkout/runtime.
    Write-TestPresence -Paths $paths -ObservedAt ([DateTimeOffset]::UtcNow.AddSeconds(-30).ToString("o"))
    function Test-ArtemKioskRunning { return $false }
    function Get-ArtemEdgeExecutable { return "fake-msedge.exe" }
    function Start-Process { return $null }
    function Start-ArtemKioskWatcher { }
    function Stop-ArtemKiosk { }
    function Test-ArtemSoftwareUpdateActive { return $true }

    $softResult = Ensure-ArtemKioskVisible -Paths $paths -TimeoutSeconds 0
    if ($softResult -ne $false) {
        throw "Updater kiosk timeout must return a soft false result"
    }
    if (Test-Path -LiteralPath (Get-ArtemKioskPresencePath -Paths $paths)) {
        throw "Stale heartbeat must be cleared before a fresh kiosk launch"
    }

    function Test-ArtemSoftwareUpdateActive { return $false }
    $strictFailed = $false
    try {
        Ensure-ArtemKioskVisible -Paths $paths -TimeoutSeconds 0 | Out-Null
    }
    catch {
        $strictFailed = $_.Exception.Message -like "*kiosk presence was not confirmed*"
    }
    if (-not $strictFailed) {
        throw "Ordinary Open must remain strict when no dashboard presence appears"
    }

    # Status must preserve positive ownership evidence when one advisory signal
    # is stale; it reports degraded rather than a contradictory kiosk=false.
    function Test-ArtemKioskRunning { return $true }
    Write-TestPresence -Paths $paths -ObservedAt ([DateTimeOffset]::UtcNow.AddSeconds(-30).ToString("o"))
    $degraded = Get-ArtemKioskStatus -Paths $paths -RuntimeReady $true
    if ($degraded.Status -ne "degraded" -or -not $degraded.Open) {
        throw "Owned kiosk with stale presence must report degraded/open, not stopped"
    }
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated dashboard heartbeat kiosk authority, panel-profile binding, stale/future rejection, strict Open and soft updater recovery."
