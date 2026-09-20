$ErrorActionPreference = "Stop"

function Update-ArtemProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Get-ArtemRuntimePaths {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
    $runtimeRoot = Join-Path $env:LOCALAPPDATA "ArtemControlCenter"
    [pscustomobject]@{
        RepoRoot = $repoRoot
        RuntimeRoot = $runtimeRoot
        Knowledge = Join-Path $runtimeRoot "knowledge"
        Logs = Join-Path $runtimeRoot "logs"
        RuntimeEnv = Join-Path $runtimeRoot "runtime.env"
        Venvs = Join-Path $runtimeRoot "venvs"
        State = Join-Path $runtimeRoot "runtime-state.json"
        Command = Join-Path $runtimeRoot "runtime-command.json"
        ManualStop = Join-Path $runtimeRoot "manual-stop.json"
        EdgeProfile = Join-Path $runtimeRoot "edge-profile"
        LastKnownGood = Join-Path $runtimeRoot "last-known-good.txt"
        RollbackHead = Join-Path $runtimeRoot "rollback-head.txt"
        RollbackDashboard = Join-Path $runtimeRoot "dashboard-rollback"
        UpdateTransactionState = Join-Path $runtimeRoot "update-transaction.json"
        CapabilityApplyState = Join-Path $runtimeRoot "capability-apply-state.json"
        UpdateLock = Join-Path $runtimeRoot "update-lock.json"
        UpdateState = Join-Path $runtimeRoot "update-state.json"
        # Private diagnostic evidence only; it is never updater authority or a browser contract.
        UpdateBootstrapEvidence = Join-Path $runtimeRoot "update-bootstrap.json"
        # The short launcher records actual updater process creation here.  The
        # receipt is private evidence; script entry and ownership remain in the
        # updater bootstrap/lock/state artifacts.
        UpdateLaunchReceipt = Join-Path $runtimeRoot "update-launch.json"
        RuntimeScript = Join-Path $repoRoot "scripts\production-runtime.mjs"
        StartScript = Join-Path $repoRoot "scripts\windows\start-production.ps1"
        OpenKioskScript = Join-Path $repoRoot "scripts\windows\open-kiosk.ps1"
        KioskWatchScript = Join-Path $repoRoot "scripts\windows\watch-kiosk.ps1"
        StopScript = Join-Path $repoRoot "scripts\windows\stop-production.ps1"
        UpdaterLauncherScript = Join-Path $repoRoot "scripts\windows\launch-update-production.ps1"
        UpdateScript = Join-Path $repoRoot "scripts\windows\update-production.ps1"
        DashboardDist = Join-Path $repoRoot "apps\dashboard\dist"
        DashboardBuildMetadata = Join-Path $repoRoot "apps\dashboard\dist\dashboard-build.json"
        DashboardIndex = Join-Path $repoRoot "apps\dashboard\dist\index.html"
        PanelUrl = "http://127.0.0.1:8787/overview"
        ReadyUrl = "http://127.0.0.1:8787/health/ready"
        ProductionBuildUrl = "http://127.0.0.1:8787/api/v1/system/production-build"
    }
}

function Get-ArtemJarvisVoicePaths {
    param([Parameter(Mandatory)]$Paths)
    $root = Join-Path $Paths.RuntimeRoot "jarvis-voice"
    [pscustomobject]@{
        Root = $root
        Config = Join-Path $root "config"
        Models = Join-Path $root "models"
        Venv = Join-Path $root "venv"
        State = Join-Path $root "state"
        TaskName = "Artem Control Center Jarvis Voice"
        WorkerModule = "jarvis_voice_worker"
        LauncherScript = Join-Path $Paths.RepoRoot "scripts\windows\run-jarvis-voice.ps1"
    }
}

function Get-ArtemJarvisVoiceRuntimeKeys {
    return @(
        "PANEL_JARVIS_VOICE_ENABLED", "PANEL_JARVIS_VOICE_BRIDGE_TOKEN",
        "PANEL_JARVIS_VOICE_PANEL_URL", "PANEL_JARVIS_VOICE_MODEL_ROOT",
        "PANEL_JARVIS_WAKE_MODEL", "PANEL_JARVIS_STT_MODEL",
        "PANEL_JARVIS_STT_PROFILE", "PANEL_JARVIS_WAKE_THRESHOLD",
        "PANEL_JARVIS_MIC_DEVICE", "PANEL_JARVIS_TTS_ENABLED",
        "PANEL_JARVIS_TTS_MODEL", "PANEL_JARVIS_TTS_REFERENCE_ID",
        "PANEL_JARVIS_TTS_LATENCY"
    )
}

function Get-ArtemJarvisVoiceRuntimeEnvironment {
    param([Parameter(Mandatory)]$Paths)

    # This is intentionally not a generic runtime.env importer. Values are
    # data, never PowerShell expressions, and only the worker's fixed inputs
    # cross this process boundary.
    $allowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($key in (Get-ArtemJarvisVoiceRuntimeKeys)) { [void]$allowed.Add($key) }

    $result = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Paths.RuntimeEnv)) { return $result }
    foreach ($line in Get-Content -LiteralPath $Paths.RuntimeEnv) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        $separator = $line.IndexOf("=")
        if ($separator -lt 1) {
            # Unrelated malformed runtime.env input remains outside this narrow
            # parser. A malformed owned key, however, must not silently turn
            # into an accidental disabled/unconfigured worker.
            if ($allowed.Contains($trimmed)) {
                throw "Invalid Jarvis voice runtime.env entry"
            }
            continue
        }
        $key = $line.Substring(0, $separator).Trim()
        if ($allowed.Contains($key)) {
            # Keep everything after the first '=' literal, including quotes,
            # dollar signs and any additional '=' characters.
            $result[$key] = $line.Substring($separator + 1)
        }
    }
    return $result
}

function Set-ArtemJarvisVoiceWorkerEnvironment {
    param([Parameter(Mandatory)]$Paths)

    $values = Get-ArtemJarvisVoiceRuntimeEnvironment -Paths $Paths
    $allowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($key in (Get-ArtemJarvisVoiceRuntimeKeys)) {
        [void]$allowed.Add($key)
        Remove-Item -LiteralPath ("Env:" + $key) -ErrorAction SilentlyContinue
    }
    # A task can inherit PANEL_* values from its parent account. The voice
    # child must receive neither those unrelated settings nor any unlisted
    # secret; its entire PANEL_* boundary is the fixed allow-list above.
    foreach ($entry in @(Get-ChildItem Env: | Where-Object {
        $_.Name.StartsWith("PANEL_", [StringComparison]::OrdinalIgnoreCase) -and -not $allowed.Contains($_.Name)
    })) {
        Remove-Item -LiteralPath ("Env:" + $entry.Name) -ErrorAction SilentlyContinue
    }
    foreach ($entry in $values.GetEnumerator()) {
        # Empty optional inputs have one cross-shell representation: absent.
        # Do not rely on Windows PowerShell's empty Env: assignment behavior.
        if ([string]::IsNullOrEmpty([string]$entry.Value)) { continue }
        Set-Item -LiteralPath ("Env:" + $entry.Key) -Value ([string]$entry.Value)
    }
    return $values
}

function Get-ArtemJarvisVoiceConfiguration {
    param(
        [Parameter(Mandatory)]$Paths,
        [System.Collections.IDictionary]$Environment
    )

    if (-not $PSBoundParameters.ContainsKey('Environment')) {
        $Environment = Get-ArtemJarvisVoiceRuntimeEnvironment -Paths $Paths
    }
    $value = { param([string]$Key) if ($Environment.Contains($Key)) { [string]$Environment[$Key] } else { "" } }
    $enabled = (& $value "PANEL_JARVIS_VOICE_ENABLED") -eq "true"
    $token = & $value "PANEL_JARVIS_VOICE_BRIDGE_TOKEN"
    $panelUrl = & $value "PANEL_JARVIS_VOICE_PANEL_URL"
    $modelRoot = & $value "PANEL_JARVIS_VOICE_MODEL_ROOT"
    $wakeModel = & $value "PANEL_JARVIS_WAKE_MODEL"
    $sttModel = & $value "PANEL_JARVIS_STT_MODEL"
    $profile = & $value "PANEL_JARVIS_STT_PROFILE"
    $threshold = & $value "PANEL_JARVIS_WAKE_THRESHOLD"
    $ttsRequested = (& $value "PANEL_JARVIS_TTS_ENABLED") -eq "true"
    $ttsEnabled = $enabled -and $ttsRequested
    $ttsModel = & $value "PANEL_JARVIS_TTS_MODEL"
    $ttsReferenceId = & $value "PANEL_JARVIS_TTS_REFERENCE_ID"
    $ttsLatency = & $value "PANEL_JARVIS_TTS_LATENCY"
    $localPanel = $false
    try {
        $uri = [Uri]$panelUrl
        $localPanel = $uri.Scheme -eq "http" -and $uri.IsLoopback
    }
    catch { $localPanel = $false }
    $thresholdValue = 0.0
    $validThreshold = [double]::TryParse($threshold, [ref]$thresholdValue) -and $thresholdValue -ge 0.1 -and $thresholdValue -le 0.95
    $ingressConfigured = (
        $enabled -and $token.Length -gt 0 -and $localPanel -and
        $modelRoot.Length -gt 0 -and $wakeModel.Length -gt 0 -and $sttModel.Length -gt 0 -and
        $profile -in @("base", "small") -and $validThreshold
    )
    # FISH_API_KEY remains an inherited User-environment secret. It is never
    # imported from runtime.env or returned in this configuration/status shape.
    $fishApiKey = if ($ttsEnabled) { [Environment]::GetEnvironmentVariable("FISH_API_KEY", "Process") } else { "" }
    $ttsConfigured = (
        $ttsEnabled -and
        ($ttsModel -in @("s2.1-pro-free", "s2.1-pro")) -and
        ($ttsReferenceId.Length -gt 0) -and
        ($ttsLatency -in @("balanced", "normal")) -and
        -not [string]::IsNullOrEmpty($fishApiKey)
    )
    $configured = $ingressConfigured -and (-not $ttsEnabled -or $ttsConfigured)
    # Local STT readiness remains truthful even if optional cloud speech is
    # disabled or unavailable.
    $modelsReady = $ingressConfigured -and
        (Test-Path -LiteralPath $modelRoot -PathType Container) -and
        (Test-Path -LiteralPath $wakeModel) -and
        (Test-Path -LiteralPath $sttModel)
    return [pscustomobject]@{
        Enabled = $enabled
        Configured = $configured
        ModelsReady = $modelsReady
        TtsEnabled = $ttsEnabled
        TtsConfigured = $ttsConfigured
        Environment = $Environment
    }
}

function Get-ArtemJarvisVoiceWorkers {
    param([Parameter(Mandatory)]$Voice)
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq "python.exe" -and $_.CommandLine -like "*$($Voice.WorkerModule)*"
    })
}

function Get-ArtemJarvisVoiceSessionAlignment {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Workers,
        [object]$ConsoleSessionId
    )
    if (-not $PSBoundParameters.ContainsKey('ConsoleSessionId')) {
        $ConsoleSessionId = Get-ArtemActiveConsoleSessionId
    }
    $sessionIds = New-Object System.Collections.Generic.List[object]
    $unknown = $false
    foreach ($worker in $Workers) {
        try {
            if ($null -eq $worker.SessionId) { throw "missing" }
            $sessionIds.Add([int]$worker.SessionId) | Out-Null
        }
        catch {
            $sessionIds.Add($null) | Out-Null
            $unknown = $true
        }
    }
    $hasConsole = $null -ne $ConsoleSessionId
    $aligned = (
        $Workers.Count -eq 1 -and $hasConsole -and [int]$ConsoleSessionId -ne 0 -and
        -not $unknown -and $sessionIds.Count -eq 1 -and [int]$sessionIds[0] -eq [int]$ConsoleSessionId
    )
    return [pscustomobject]@{
        WorkerCount = $Workers.Count
        # Materialize the generic list before constructing the PSCustomObject.
        # Windows PowerShell 5.1 can throw "Argument types do not match" when
        # a generic List[object] is embedded through the array-subexpression.
        WorkerSessionIds = [object[]]$sessionIds.ToArray()
        ConsoleSessionId = if ($hasConsole) { [int]$ConsoleSessionId } else { $null }
        SessionAligned = $aligned
        HasUnknownSession = $unknown
    }
}

function Get-ArtemJarvisVoiceStartDecision {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Workers,
        [Parameter(Mandatory)][string]$TaskState,
        [object]$ConsoleSessionId
    )
    $alignmentArgs = @{ Workers = $Workers }
    if ($PSBoundParameters.ContainsKey('ConsoleSessionId')) {
        $alignmentArgs.ConsoleSessionId = $ConsoleSessionId
    }
    $alignment = Get-ArtemJarvisVoiceSessionAlignment @alignmentArgs
    if ($alignment.WorkerCount -eq 0) {
        return [pscustomobject]@{ Action = "start"; Message = $null }
    }
    if ($alignment.WorkerCount -gt 1) {
        return [pscustomobject]@{ Action = "reject"; Message = "Refusing to start duplicate Jarvis voice workers." }
    }
    if ($alignment.SessionAligned) {
        return [pscustomobject]@{ Action = "no-op"; Message = $null }
    }
    if ($TaskState -eq "Running") {
        return [pscustomobject]@{ Action = "restart"; Message = $null }
    }
    return [pscustomobject]@{
        Action = "reject"
        Message = "Refusing to start while an unowned or wrong-session Jarvis voice worker exists."
    }
}

function Invoke-ArtemJarvisVoiceStartLifecycle {
    param(
        [Parameter(Mandatory)]$Voice,
        [Parameter(Mandatory)][object[]]$Workers,
        [Parameter(Mandatory)][string]$TaskState,
        [scriptblock]$StopTask,
        [Parameter(Mandatory)][scriptblock]$StartTask,
        [Parameter(Mandatory)][scriptblock]$WorkerProvider,
        [object]$ConsoleSessionId,
        [ValidateRange(1, 60000)][int]$StopTimeoutMilliseconds = 10000,
        [ValidateRange(1, 10000)][int]$PollMilliseconds = 250,
        [scriptblock]$Sleep = { param([int]$Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    )
    $decisionArgs = @{ Workers = $Workers; TaskState = $TaskState }
    if ($PSBoundParameters.ContainsKey('ConsoleSessionId')) {
        $decisionArgs.ConsoleSessionId = $ConsoleSessionId
    }
    $decision = Get-ArtemJarvisVoiceStartDecision @decisionArgs
    if ($decision.Action -eq "reject") { throw $decision.Message }
    if ($decision.Action -eq "no-op") { return $decision }
    if ($decision.Action -eq "start") {
        $null = & $StartTask
        return $decision
    }

    # A misaligned worker is stopped only through the installed task. If it is
    # not task-owned or fails to exit, do not create a duplicate and do not
    # kill an arbitrary matching python process.
    if ($null -eq $StopTask) { throw "Jarvis voice task stop callback is required for restart." }
    $null = & $StopTask
    $waited = 0
    while ($true) {
        $remaining = @(& $WorkerProvider)
        if ($remaining.Count -eq 0) { break }
        if ($waited -ge $StopTimeoutMilliseconds) {
            throw "Jarvis voice worker did not stop after bounded task shutdown."
        }
        $delay = [Math]::Min($PollMilliseconds, $StopTimeoutMilliseconds - $waited)
        & $Sleep $delay
        $waited += $delay
    }
    $null = & $StartTask
    return $decision
}

function Get-ArtemRuntimeVenvPath {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Revision
    )
    return Join-Path $Paths.Venvs $Revision.ToLowerInvariant()
}

function Get-ArtemRuntimePythonPath {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Revision
    )
    return Join-Path (Get-ArtemRuntimeVenvPath -Paths $Paths -Revision $Revision) "Scripts\python.exe"
}

function Get-ArtemCheckoutRevision {
    param([Parameter(Mandatory)]$Paths)
    $revision = (& git.exe -C $Paths.RepoRoot rev-parse HEAD).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{40}$') {
        throw "Unable to resolve the production checkout revision"
    }
    return $revision
}

function Initialize-ArtemRuntimeDirectories {
    param([Parameter(Mandatory)]$Paths)
    New-Item -ItemType Directory -Force -Path $Paths.RuntimeRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $Paths.Knowledge | Out-Null
    New-Item -ItemType Directory -Force -Path $Paths.Logs | Out-Null
    New-Item -ItemType Directory -Force -Path $Paths.EdgeProfile | Out-Null
    New-Item -ItemType Directory -Force -Path $Paths.Venvs | Out-Null
}

function Get-ArtemJsonPayload {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Get-ArtemRuntimeState {
    param([Parameter(Mandatory)]$Paths)
    return Get-ArtemJsonPayload -Path $Paths.State
}

function Test-ArtemRuntimeProcess {
    param([Parameter(Mandatory)]$Paths)
    $state = Get-ArtemRuntimeState -Paths $Paths
    if ($null -eq $state -or $null -eq $state.supervisorPid) { return $false }
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.supervisorPid)"
        return (
            $null -ne $process -and
            $process.Name -ieq "node.exe" -and
            $process.CommandLine -like "*production-runtime.mjs*"
        )
    }
    catch {
        return $false
    }
}

function Test-ArtemPanelReady {
    param([Parameter(Mandatory)]$Paths)
    try {
        $response = Invoke-WebRequest `
            -Uri $Paths.ReadyUrl `
            -UseBasicParsing `
            -TimeoutSec 3
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Get-ArtemProductionBuildIdentity {
    param(
        [Parameter(Mandatory)][string]$DashboardRoot
    )
    $marker = Join-Path $DashboardRoot "dashboard-build.json"
    $payload = Get-ArtemJsonPayload -Path $marker
    $keys = if ($null -ne $payload) { @($payload.PSObject.Properties.Name | Sort-Object) } else { @() }
    if (
        $null -eq $payload -or
        $keys.Count -ne 4 -or
        ($keys -join ",") -ne "buildId,profile,revision,schemaVersion" -or
        $payload.schemaVersion -ne "dashboard-build.v1" -or
        [string]$payload.revision -notmatch '^[0-9a-f]{40}$' -or
        [string]$payload.profile -ne "accepted-v2" -or
        [string]$payload.buildId -ne ("{0}:{1}" -f $payload.revision, $payload.profile)
    ) {
        return $null
    }
    return [pscustomobject]@{
        SchemaVersion = [string]$payload.schemaVersion
        Revision = [string]$payload.revision
        Profile = [string]$payload.profile
        BuildId = [string]$payload.buildId
    }
}

function Assert-ArtemProductionBuildIdentity {
    param(
        [Parameter(Mandatory)][string]$DashboardRoot,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision
    )
    $identity = Get-ArtemProductionBuildIdentity -DashboardRoot $DashboardRoot
    if ($null -eq $identity -or $identity.Revision -ne $ExpectedRevision -or $identity.Profile -ne "accepted-v2") {
        throw "Production dashboard artifact identity does not match the expected revision/profile"
    }
    return $identity
}

function Get-ArtemServedProductionBuildIdentity {
    param([Parameter(Mandatory)]$Paths)
    try {
        $payload = Invoke-RestMethod -Uri $Paths.ProductionBuildUrl -Method Get -TimeoutSec 5
        $keys = if ($null -ne $payload) { @($payload.PSObject.Properties.Name | Sort-Object) } else { @() }
        if (
            $null -eq $payload -or
            $keys.Count -ne 4 -or
            ($keys -join ",") -ne "buildId,profile,revision,schemaVersion" -or
            [string]$payload.schemaVersion -ne "dashboard-build.v1" -or
            [string]$payload.revision -notmatch '^[0-9a-f]{40}$' -or
            [string]$payload.profile -ne "accepted-v2" -or
            [string]$payload.buildId -ne ("{0}:{1}" -f $payload.revision, $payload.profile)
        ) {
            return $null
        }
        return [pscustomobject]@{
            SchemaVersion = [string]$payload.schemaVersion
            Revision = [string]$payload.revision
            Profile = [string]$payload.profile
            BuildId = [string]$payload.buildId
        }
    }
    catch {
        return $null
    }
}

function Assert-ArtemServedProductionBuildIdentity {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision
    )
    $identity = Get-ArtemServedProductionBuildIdentity -Paths $Paths
    if ($null -eq $identity -or $identity.Revision -ne $ExpectedRevision -or $identity.Profile -ne "accepted-v2") {
        throw "Served production dashboard artifact does not match the expected revision/profile"
    }
    return $identity
}

function Test-ArtemProductionDeploymentHealthy {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision
    )
    try {
        # A valid marker without the required production entrypoint is an
        # incomplete artifact and must not make a same-SHA update a no-op.
        if (-not (Test-Path -LiteralPath (Join-Path $Paths.DashboardDist "index.html"))) {
            return $false
        }
        Assert-ArtemProductionBuildIdentity `
            -DashboardRoot $Paths.DashboardDist `
            -ExpectedRevision $ExpectedRevision | Out-Null
        if (-not (Test-ArtemRuntimeProcess -Paths $Paths) -or -not (Test-ArtemPanelReady -Paths $Paths)) {
            return $false
        }
        Assert-ArtemServedProductionBuildIdentity `
            -Paths $Paths `
            -ExpectedRevision $ExpectedRevision | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Assert-ArtemStagedProductionBuild {
    param(
        [Parameter(Mandatory)][string]$DashboardRoot,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision
    )
    if (-not (Test-Path -LiteralPath (Join-Path $DashboardRoot "index.html"))) {
        throw "Target production build has no dashboard index"
    }
    Assert-ArtemProductionBuildIdentity -DashboardRoot $DashboardRoot -ExpectedRevision $ExpectedRevision | Out-Null
}

function Promote-ArtemProductionBuild {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][string]$StagedDashboard
    )
    if (-not (Test-Path -LiteralPath (Join-Path $StagedDashboard "index.html"))) {
        throw "Cannot promote a missing staged production dashboard"
    }

    # Keep the last known-good generated artifact outside the checkout until
    # served-artifact verification has completed. This is a narrow generated
    # directory, never the repository root or a user-owned runtime directory.
    if (Test-Path -LiteralPath $Paths.DashboardDist) {
        if (Test-Path -LiteralPath $Paths.RollbackDashboard) {
            Remove-Item -LiteralPath $Paths.DashboardDist -Recurse -Force
        }
        else {
            Move-Item -LiteralPath $Paths.DashboardDist -Destination $Paths.RollbackDashboard
        }
    }
    Move-Item -LiteralPath $StagedDashboard -Destination $Paths.DashboardDist
}

function Assert-ArtemTargetUpdaterLogic {
    param(
        [Parameter(Mandatory)]$Paths,
        [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedTargetHead
    )
    Push-Location -LiteralPath $Paths.RepoRoot
    try {
        $head = (& git.exe rev-parse HEAD).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $head -ne $ExpectedTargetHead.ToLowerInvariant()) {
            throw "Target updater checkout is not at the expected revision"
        }

        # Compare the updater loaded by PowerShell with the exact target tree blob.
        # The path is fixed by the repository contract; no caller-controlled script
        # path, ref, branch, or shell command participates in this proof.
        $targetBlob = (& git.exe rev-parse "${ExpectedTargetHead}:scripts/windows/update-production.ps1").Trim().ToLowerInvariant()
        $workingBlob = (& git.exe hash-object --path=scripts/windows/update-production.ps1 $Paths.UpdateScript).Trim().ToLowerInvariant()
        if (
            $LASTEXITCODE -ne 0 -or
            $targetBlob -notmatch '^[0-9a-f]{40}$' -or
            $workingBlob -notmatch '^[0-9a-f]{40}$' -or
            $targetBlob -ne $workingBlob
        ) {
            throw "Target updater logic does not match the expected target revision"
        }
    }
    finally {
        Pop-Location
    }
}

function Wait-ArtemPanelReady {
    param(
        [Parameter(Mandatory)]$Paths,
        [int]$TimeoutSeconds = 60
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-ArtemPanelReady -Paths $Paths) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Test-ArtemStateRecent {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$ActiveStatuses,
        [Parameter(Mandatory)][int]$MaxAgeMinutes
    )
    $payload = Get-ArtemJsonPayload -Path $Path
    if ($null -eq $payload -or $payload.schemaVersion -ne 1) { return $false }
    if ([string]$payload.status -notin $ActiveStatuses) { return $false }
    try {
        $updated = [DateTimeOffset]::Parse([string]$payload.updatedAt).ToUniversalTime()
        $age = [DateTimeOffset]::UtcNow - $updated
        return $age.TotalSeconds -ge 0 -and $age.TotalMinutes -le $MaxAgeMinutes
    }
    catch {
        return $false
    }
}

function Test-ArtemCapabilityApplyActive {
    param([Parameter(Mandatory)]$Paths)
    return Test-ArtemStateRecent `
        -Path $Paths.CapabilityApplyState `
        -ActiveStatuses @("queued", "building", "restarting") `
        -MaxAgeMinutes 15
}

function Test-ArtemUpdaterOwnerProcess {
    param(
        [Parameter(Mandatory)][int]$OwnerPid,
        [Parameter(Mandatory)][string]$RequestId
    )
    if ($OwnerPid -le 0 -or $RequestId -notmatch '^[0-9a-f]{24}$') { return $false }
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerPid" -ErrorAction SilentlyContinue
        $hasRequestArgument = $null -ne $process -and $process.CommandLine -like "*-RequestId*"
        return (
            $null -ne $process -and
            $process.Name -in @("powershell.exe", "pwsh.exe") -and
            $null -ne $process.CommandLine -and
            $process.CommandLine -like "*update-production.ps1*" -and
            (-not $hasRequestArgument -or $process.CommandLine -like "*$RequestId*")
        )
    }
    catch {
        return $false
    }
}

function Get-ArtemSoftwareUpdateLock {
    param([Parameter(Mandatory)]$Paths)
    $payload = Get-ArtemJsonPayload -Path $Paths.UpdateLock
    if ($null -eq $payload -or $payload.schemaVersion -ne 1 -or $payload.status -ne "updating") {
        return $null
    }
    $requestId = [string]$payload.requestId
    if ($requestId -notmatch '^[0-9a-f]{24}$') { return $null }

    try {
        $updated = [DateTimeOffset]::Parse([string]$payload.updatedAt).ToUniversalTime()
    }
    catch {
        Remove-Item -LiteralPath $Paths.UpdateLock -Force -ErrorAction SilentlyContinue
        return $null
    }

    if ($null -ne $payload.ownerPid) {
        try { $ownerPid = [int]$payload.ownerPid }
        catch {
            Remove-Item -LiteralPath $Paths.UpdateLock -Force -ErrorAction SilentlyContinue
            return $null
        }
        if (Test-ArtemUpdaterOwnerProcess -OwnerPid $ownerPid -RequestId $requestId) {
            return $payload
        }
        Remove-Item -LiteralPath $Paths.UpdateLock -Force -ErrorAction SilentlyContinue
        return $null
    }

    # Before the independent updater claims the lease there is deliberately no PID.
    # Keep that handoff window short. A future timestamp is never allowed to turn
    # this pre-owner lease into an immortal maintenance block.
    $age = [DateTimeOffset]::UtcNow - $updated
    if ($age.TotalSeconds -lt 0 -or $age.TotalMinutes -gt 2) {
        Remove-Item -LiteralPath $Paths.UpdateLock -Force -ErrorAction SilentlyContinue
        return $null
    }
    return $payload
}

function Test-ArtemSoftwareUpdateActive {
    param([Parameter(Mandatory)]$Paths)
    return $null -ne (Get-ArtemSoftwareUpdateLock -Paths $Paths)
}

function Get-ArtemEdgeExecutable {
    $candidates = @()
    foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($root) {
            $candidates += Join-Path $root "Microsoft\Edge\Application\msedge.exe"
        }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "Microsoft Edge executable was not found"
}

function Get-ArtemActiveConsoleSessionId {
    # WTSGetActiveConsoleSessionId is locale-independent and identifies the
    # physical console desktop without parsing the localized quser output.
    if ($null -eq ("ArtemControlCenter.ConsoleSessionNative" -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ArtemControlCenter {
    public static class ConsoleSessionNative {
        [DllImport("kernel32.dll", SetLastError = false)]
        public static extern uint WTSGetActiveConsoleSessionId();
    }
}
'@
    }

    $sessionId = [ArtemControlCenter.ConsoleSessionNative]::WTSGetActiveConsoleSessionId()
    if ($sessionId -eq [uint32]::MaxValue) { return $null }
    return [int]$sessionId
}

function Get-ArtemCurrentProcessSessionId {
    try {
        return [int](Get-Process -Id $PID -ErrorAction Stop).SessionId
    }
    catch {
        return $null
    }
}

function Get-ArtemEdgeProcessSnapshot {
    try {
        return @(
            Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
                Select-Object ProcessId, ParentProcessId, CommandLine, CreationDate, SessionId
        )
    }
    catch {
        return @()
    }
}

# Only an Edge process whose own command line carries the exact dedicated
# --user-data-dir value can seed panel ownership. Descendants inherit ownership
# through the live process tree; unrelated/personal Edge roots never do.
function Test-ArtemEdgeProfileRoot {
    param(
        [Parameter(Mandatory)]$Process,
        [Parameter(Mandatory)]$Paths
    )
    if ($null -eq $Process.CommandLine) { return $false }
    $profile = "$($Paths.EdgeProfile)"
    if ([string]::IsNullOrWhiteSpace($profile)) { return $false }
    $escapedProfile = [regex]::Escape($profile)
    $pattern = '(?i)(?:^|\s|")--user-data-dir=(?:"?' + $escapedProfile + '"?)(?=\s|$|")'
    return [regex]::IsMatch([string]$Process.CommandLine, $pattern)
}

function Get-ArtemProcessCreationTimeUtc {
    param([Parameter(Mandatory)]$Process)
    if ($null -eq $Process.CreationDate) { return $null }
    try {
        if ($Process.CreationDate -is [DateTimeOffset]) {
            return $Process.CreationDate.ToUniversalTime()
        }
        if ($Process.CreationDate -is [DateTime]) {
            return [DateTimeOffset]::new($Process.CreationDate.ToUniversalTime())
        }
        return [DateTimeOffset]::Parse([string]$Process.CreationDate).ToUniversalTime()
    }
    catch {
        return $null
    }
}

function Test-ArtemEdgeChildOfCurrentParent {
    param(
        [Parameter(Mandatory)]$Parent,
        [Parameter(Mandatory)]$Child
    )
    if ([int]$Child.ParentProcessId -ne [int]$Parent.ProcessId) { return $false }

    # ParentProcessId alone can be misleading after PID reuse. When both CIM
    # creation times are available, reject a child that predates the supposed
    # current parent process.
    $parentCreated = Get-ArtemProcessCreationTimeUtc -Process $Parent
    $childCreated = Get-ArtemProcessCreationTimeUtc -Process $Child
    if ($null -ne $parentCreated -and $null -ne $childCreated -and $childCreated -lt $parentCreated) {
        return $false
    }
    return $true
}

function Get-ArtemOwnedEdgeProcesses {
    param(
        [Parameter(Mandatory)]$Paths,
        [object[]]$Processes
    )

    if (-not $PSBoundParameters.ContainsKey('Processes')) {
        $Processes = Get-ArtemEdgeProcessSnapshot
    }
    $current = @($Processes | Where-Object { $null -ne $_ -and $null -ne $_.ProcessId })
    if ($current.Count -eq 0) { return @() }

    $owned = @{}
    $depth = @{}
    $queue = New-Object System.Collections.Queue

    foreach ($candidate in $current) {
        if (-not (Test-ArtemEdgeProfileRoot -Process $candidate -Paths $Paths)) { continue }
        $key = [string][int]$candidate.ProcessId
        if ($owned.ContainsKey($key)) { continue }
        $owned[$key] = $candidate
        $depth[$key] = 0
        $queue.Enqueue($candidate)
    }

    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        $parentKey = [string][int]$parent.ProcessId
        foreach ($candidate in $current) {
            $childKey = [string][int]$candidate.ProcessId
            if ($owned.ContainsKey($childKey)) { continue }
            if (-not (Test-ArtemEdgeChildOfCurrentParent -Parent $parent -Child $candidate)) { continue }
            $owned[$childKey] = $candidate
            $depth[$childKey] = [int]$depth[$parentKey] + 1
            $queue.Enqueue($candidate)
        }
    }

    $result = @()
    foreach ($key in $owned.Keys) {
        $process = $owned[$key]
        $result += [pscustomobject]@{
            ProcessId = [int]$process.ProcessId
            ParentProcessId = [int]$process.ParentProcessId
            CommandLine = $process.CommandLine
            CreationDate = $process.CreationDate
            SessionId = $process.SessionId
            OwnershipDepth = [int]$depth[$key]
        }
    }
    return @($result | Sort-Object OwnershipDepth, ProcessId)
}

# Broad panel-owned Edge process tree. The exact profile-bearing process is only
# the root seed; cleanup/shutdown includes every current descendant in that tree.
function Get-ArtemKioskProcesses {
    param(
        [Parameter(Mandatory)]$Paths,
        [object[]]$Processes
    )
    if ($PSBoundParameters.ContainsKey('Processes')) {
        return @(Get-ArtemOwnedEdgeProcesses -Paths $Paths -Processes $Processes)
    }
    return @(Get-ArtemOwnedEdgeProcesses -Paths $Paths)
}

function Test-ArtemKioskRunning {
    param([Parameter(Mandatory)]$Paths)
    return (Get-ArtemKioskProcesses -Paths $Paths).Count -gt 0
}

function Get-ArtemKioskSessionAlignment {
    param(
        [Parameter(Mandatory)]$Paths,
        [object[]]$OwnedProcesses,
        [object]$ConsoleSessionId
    )

    if (-not $PSBoundParameters.ContainsKey('OwnedProcesses')) {
        $OwnedProcesses = @(Get-ArtemKioskProcesses -Paths $Paths)
    }
    $owned = @($OwnedProcesses | Where-Object { $null -ne $_ })
    if (-not $PSBoundParameters.ContainsKey('ConsoleSessionId')) {
        $ConsoleSessionId = Get-ArtemActiveConsoleSessionId
    }

    $sessionIds = New-Object System.Collections.Generic.List[int]
    $hasUnknownSession = $false
    foreach ($process in $owned) {
        try {
            if ($null -eq $process.SessionId) { throw "missing" }
            $sessionIds.Add([int]$process.SessionId) | Out-Null
        }
        catch {
            $hasUnknownSession = $true
        }
    }
    $distinctSessionIds = @($sessionIds | Sort-Object -Unique)
    $hasConsole = $null -ne $ConsoleSessionId
    $aligned = (
        $owned.Count -gt 0 -and
        $hasConsole -and
        -not $hasUnknownSession -and
        $distinctSessionIds.Count -eq 1 -and
        $distinctSessionIds[0] -eq [int]$ConsoleSessionId
    )

    return [pscustomobject]@{
        HasOwnedProcesses = $owned.Count -gt 0
        ConsoleSessionId = if ($hasConsole) { [int]$ConsoleSessionId } else { $null }
        ProcessSessionIds = @($distinctSessionIds)
        SessionAligned = $aligned
        HasUnknownSession = $hasUnknownSession
        HasWrongSessionProcess = (
            $owned.Count -gt 0 -and
            (-not $hasConsole -or $hasUnknownSession -or -not $aligned)
        )
    }
}

function Start-ArtemInteractiveRuntimeTask {
    param([Parameter(Mandatory)]$Paths)

    # This is the one installed Interactive task. Restarting a currently-running
    # invocation is required for Task Scheduler to create a fresh interactive
    # session handoff; the healthy runtime itself is not stopped here.
    $task = Get-ScheduledTask -TaskName "Artem Control Center Runtime" -ErrorAction SilentlyContinue
    if ($null -eq $task) { return $false }
    if ($task.State -eq "Running") {
        Stop-ScheduledTask -TaskName "Artem Control Center Runtime" -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    Start-ScheduledTask -TaskName "Artem Control Center Runtime"
    return $true
}

function Stop-ArtemKiosk {
    param(
        [Parameter(Mandatory)]$Paths,
        [object[]]$Processes,
        [scriptblock]$ProcessStopper
    )
    try {
        $owned = if ($PSBoundParameters.ContainsKey('Processes')) {
            @(Get-ArtemKioskProcesses -Paths $Paths -Processes $Processes)
        }
        else {
            @(Get-ArtemKioskProcesses -Paths $Paths)
        }
        if ($null -eq $ProcessStopper) {
            $ProcessStopper = {
                param($ProcessId)
                Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
            }
        }

        # Stop deepest descendants first so killing the profile root cannot orphan
        # a still-running kiosk child before it has been included in cleanup.
        $ordered = @(
            $owned | Sort-Object -Property `
                @{ Expression = { [int]$_.OwnershipDepth }; Descending = $true }, `
                @{ Expression = { [int]$_.ProcessId }; Descending = $true }
        )
        foreach ($process in $ordered) {
            & $ProcessStopper ([int]$process.ProcessId)
        }
        # The owner token is advisory status evidence. Remove it with the
        # explicit cleanup so a stopped kiosk cannot look degraded merely
        # because its last watcher claim remains on disk.
        Remove-Item -LiteralPath (Join-Path $Paths.RuntimeRoot "kiosk-watcher-owner.json") -Force -ErrorAction SilentlyContinue
    }
    catch {
        Write-Warning "Unable to close the panel-owned Edge kiosk: $($_.Exception.Message)"
    }
}

function Start-ArtemKioskWatcher {
    param([Parameter(Mandatory)]$Paths)
    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile",
            "-WindowStyle", "Hidden",
            "-ExecutionPolicy", "Bypass",
            "-File", $Paths.KioskWatchScript
        ) `
        -WindowStyle Hidden | Out-Null
}

function Write-ArtemRuntimeCommand {
    param(
        [Parameter(Mandatory)]$Paths,
        [ValidateSet("hide", "shutdown")]
        [string]$Action,
        [bool]$Manual = $true
    )
    Initialize-ArtemRuntimeDirectories -Paths $Paths
    $payload = [ordered]@{
        schemaVersion = 1
        action = $Action
        manual = $Manual
        requestedAt = [DateTime]::UtcNow.ToString("o")
        requestedBy = "windows-helper"
    }
    $temporary = "$($Paths.Command).tmp"
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding ASCII
    Move-Item -LiteralPath $temporary -Destination $Paths.Command -Force
}

function Write-ArtemManualStopMarker {
    param([Parameter(Mandatory)]$Paths)
    Initialize-ArtemRuntimeDirectories -Paths $Paths
    $payload = [ordered]@{
        schemaVersion = 1
        reason = "manual_shutdown"
        createdAt = [DateTime]::UtcNow.ToString("o")
    }
    $payload | ConvertTo-Json | Set-Content -LiteralPath $Paths.ManualStop -Encoding ASCII
}

function Stop-ArtemRuntime {
    param(
        [Parameter(Mandatory)]$Paths,
        [bool]$Manual = $true,
        [int]$TimeoutSeconds = 20
    )
    $state = Get-ArtemRuntimeState -Paths $Paths
    $running = Test-ArtemRuntimeProcess -Paths $Paths

    if ($Manual) { Write-ArtemManualStopMarker -Paths $Paths }
    Stop-ArtemKiosk -Paths $Paths

    if (-not $running) {
        Remove-Item -LiteralPath $Paths.Command -Force -ErrorAction SilentlyContinue
        return
    }

    Write-ArtemRuntimeCommand -Paths $Paths -Action "shutdown" -Manual $Manual
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ArtemRuntimeProcess -Paths $Paths)) { return }
        Start-Sleep -Milliseconds 300
    }

    if ($null -ne $state.supervisorPid) {
        & taskkill.exe /PID $state.supervisorPid /T /F | Out-Null
    }
    if (Test-ArtemRuntimeProcess -Paths $Paths) {
        throw "Production runtime did not stop"
    }
}

function Assert-ArtemProductionPrerequisites {
    param([Parameter(Mandatory)]$Paths)
    Update-ArtemProcessPath
    $revision = Get-ArtemCheckoutRevision -Paths $Paths
    $python = Get-ArtemRuntimePythonPath -Paths $Paths -Revision $revision
    if (-not (Test-Path -LiteralPath $Paths.RuntimeScript)) {
        throw "Production runtime script is missing: $($Paths.RuntimeScript)"
    }
    if (-not (Test-Path -LiteralPath $python)) {
        throw "Python environment is missing. Run npm run setup."
    }
    if (-not (Test-Path -LiteralPath $Paths.DashboardIndex)) {
        throw "Production dashboard build is missing. Run npm run build:production."
    }
    if ($null -eq (Get-ArtemProductionBuildIdentity -DashboardRoot $Paths.DashboardDist)) {
        throw "Production dashboard build identity is missing or invalid. Run npm run build:production."
    }
    $null = Get-Command node.exe -ErrorAction Stop
}

$updaterRecoveryScript = Join-Path $PSScriptRoot "updater-recovery.ps1"
if (Test-Path -LiteralPath $updaterRecoveryScript) {
    . $updaterRecoveryScript
}

$kioskPresenceScript = Join-Path $PSScriptRoot "kiosk-presence.ps1"
if (Test-Path -LiteralPath $kioskPresenceScript) {
    . $kioskPresenceScript
}
