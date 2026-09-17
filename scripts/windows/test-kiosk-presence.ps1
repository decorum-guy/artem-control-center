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

function New-TestKioskProcess {
    param([Parameter(Mandatory)][int]$SessionId)
    return [pscustomobject]@{
        ProcessId = 100 + $SessionId
        ParentProcessId = 1
        CommandLine = "msedge.exe --user-data-dir=`"$($paths.EdgeProfile)`""
        CreationDate = [DateTimeOffset]::UtcNow
        SessionId = $SessionId
    }
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

    $consoleKiosk = @(New-TestKioskProcess -SessionId 2)
    $wrongSessionKiosk = @(New-TestKioskProcess -SessionId 0)

    # Presence alone is insufficient: it must be paired with the dedicated panel
    # Edge profile in the active physical console session.
    if (Test-ArtemKioskVisible -Paths $paths -Processes @() -ConsoleSessionId 2) {
        throw "Fresh heartbeat without panel-owned Edge must not count as kiosk"
    }
    if (Test-ArtemKioskVisible -Paths $paths -Processes $wrongSessionKiosk -ConsoleSessionId 2) {
        throw "Fresh heartbeat plus Session 0 dedicated Edge must not count as owner-visible kiosk"
    }
    $consoleVisible = @(Test-ArtemKioskVisible -Paths $paths -Processes $consoleKiosk -ConsoleSessionId 2)
    if (-not $consoleVisible -or -not [bool]$consoleVisible[-1]) {
        throw "Fresh application presence plus console-session panel Edge must be kiosk authority. VisibleCount=$($consoleVisible.Count) Visible=[$($consoleVisible -join ',')]"
    }

    $wrongStatus = Get-ArtemKioskStatus `
        -Paths $paths `
        -RuntimeReady $true `
        -Processes $wrongSessionKiosk `
        -ConsoleSessionId 2
    if ($wrongStatus.Status -eq "running" -or $wrongStatus.SessionAligned -or $wrongStatus.ConsoleSessionId -ne 2) {
        throw "Fresh Session 0 kiosk evidence must report degraded rather than running for console Session 2"
    }
    $correctStatus = Get-ArtemKioskStatus `
        -Paths $paths `
        -RuntimeReady $true `
        -Processes $consoleKiosk `
        -ConsoleSessionId 2
    if ($correctStatus.Status -ne "running" -or -not $correctStatus.SessionAligned) {
        throw "Fresh dedicated Edge in console Session 2 must report running"
    }
    $mixedStatus = Get-ArtemKioskStatus `
        -Paths $paths `
        -RuntimeReady $true `
        -Processes @($consoleKiosk + $wrongSessionKiosk) `
        -ConsoleSessionId 2
    if ($mixedStatus.Status -eq "running" -or -not $mixedStatus.HasWrongSessionProcess) {
        throw "Mixed console and hidden dedicated Edge trees must not silently report running"
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
    function Get-ArtemEdgeExecutable { return "fake-msedge.exe" }
    function Start-Process { return $null }
    function Start-ArtemKioskWatcher { }
    function Stop-ArtemKiosk { }
    function Get-ArtemActiveConsoleSessionId { return 2 }
    function Get-ArtemCurrentProcessSessionId { return 2 }
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
    Write-TestPresence -Paths $paths -ObservedAt ([DateTimeOffset]::UtcNow.AddSeconds(-30).ToString("o"))
    $degraded = Get-ArtemKioskStatus `
        -Paths $paths `
        -RuntimeReady $true `
        -Processes $consoleKiosk `
        -ConsoleSessionId 2
    if ($degraded.Status -ne "degraded" -or -not $degraded.Open) {
        throw "Owned kiosk with stale presence must report degraded/open, not stopped"
    }

    # A Session 0 caller must hand off to the one existing Interactive runtime
    # task. It must never use the ordinary direct Edge launch from Session 0.
    $script:testVisible = $false
    $script:interactiveTaskStarts = 0
    $script:directEdgeStarts = 0
    $script:testCallerSessionId = 0
    function Get-ArtemCurrentProcessSessionId { return $script:testCallerSessionId }
    function Test-ArtemSoftwareUpdateActive { return $false }
    function Start-ArtemInteractiveRuntimeTask {
        param($Paths)
        $script:interactiveTaskStarts++
        $script:testVisible = $true
        return $true
    }
    function Start-Process {
        $script:directEdgeStarts++
        $script:testVisible = $true
        return $null
    }
    if (-not (Ensure-ArtemKioskVisible -Paths $paths -TimeoutSeconds 1 -VisibilityProbe { $script:testVisible })) {
        throw "Session 0 caller must be able to request console kiosk recovery through the Interactive task"
    }
    if ($script:interactiveTaskStarts -ne 1 -or $script:directEdgeStarts -ne 0) {
        throw "Session 0 kiosk recovery must select the Interactive task instead of direct Edge launch"
    }

    # A caller already in the active console retains the bounded direct launch.
    $script:testVisible = $false
    $script:interactiveTaskStarts = 0
    $script:directEdgeStarts = 0
    $script:testCallerSessionId = 2
    if (-not (Ensure-ArtemKioskVisible -Paths $paths -TimeoutSeconds 1 -VisibilityProbe { $script:testVisible })) {
        throw "Console-session caller must retain the direct kiosk launch path"
    }
    if ($script:interactiveTaskStarts -ne 0 -or $script:directEdgeStarts -ne 1) {
        throw "Console-session kiosk recovery must remain direct and must not restart the Interactive task"
    }
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated session-aware dashboard heartbeat kiosk authority, bounded Interactive-task recovery, stale/future rejection, strict Open and soft updater recovery."
