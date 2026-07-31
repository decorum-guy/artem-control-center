param(
    [switch]$Json
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "connectivity-common.ps1")

$paths = Get-ArtemRuntimePaths
$connectivityPaths = Get-ArtemConnectivityPaths
$state = Get-ArtemRuntimeState -Paths $paths
$runtimeTask = Get-ScheduledTask -TaskName "Artem Control Center Runtime" -ErrorAction SilentlyContinue
$connectivityTask = Get-ScheduledTask -TaskName $connectivityPaths.TaskName -ErrorAction SilentlyContinue
$connectivityConfig = Get-ArtemConnectivityConfig -Paths $connectivityPaths
$readyPayload = $null
$snapshot = $null

if (Test-ArtemPanelReady -Paths $paths) {
    try {
        $readyPayload = Invoke-RestMethod -Uri $paths.ReadyUrl -Method Get -TimeoutSec 5
        $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/v1/snapshot" -Method Get -TimeoutSec 5
    }
    catch {
        $readyPayload = $null
        $snapshot = $null
    }
}

function Get-ServiceSnapshot {
    param([string]$ServiceId)
    if ($null -eq $snapshot) { return $null }
    return $snapshot.services | Where-Object { $_.id -eq $ServiceId } | Select-Object -First 1
}

$ha = Get-ServiceSnapshot -ServiceId "home-assistant"
$alice = Get-ServiceSnapshot -ServiceId "alice-tg-bot"
$avalarMain = Get-ServiceSnapshot -ServiceId "avalar-site-main"
$avalarStage = Get-ServiceSnapshot -ServiceId "avalar-site-stage"

$status = [ordered]@{
    runtimeProcess = Test-ArtemRuntimeProcess -Paths $paths
    panelReady = Test-ArtemPanelReady -Paths $paths
    kioskOpen = Test-ArtemKioskRunning -Paths $paths
    manualStop = Test-Path -LiteralPath $paths.ManualStop
    scheduledTask = $null -ne $runtimeTask
    scheduledTaskState = if ($runtimeTask) { [string]$runtimeTask.State } else { $null }
    supervisorPid = if ($state) { $state.supervisorPid } else { $null }
    agentPid = if ($state) { $state.agentPid } else { $null }
    mode = if ($state) { $state.mode } else { $null }
    revision = if ($state) { $state.revision } else { $null }
    runtimeStatus = if ($state) { $state.status } else { $null }
    writesEnabled = if ($readyPayload) { [bool]$readyPayload.writesEnabled } else { $null }

    connectivityConfigured = $null -ne $connectivityConfig
    connectivityReady = Test-ArtemConnectivityReady -Paths $connectivityPaths
    connectivitySupervisor = Test-ArtemConnectivitySupervisor -Paths $connectivityPaths
    connectivitySshProcess = Test-ArtemConnectivitySshProcess -Paths $connectivityPaths
    connectivityManualStop = Test-Path -LiteralPath $connectivityPaths.StopMarker
    connectivityTask = $null -ne $connectivityTask
    connectivityTaskState = if ($connectivityTask) { [string]$connectivityTask.State } else { $null }
    haTunnelPortReady = if ($connectivityConfig) { Test-ArtemTcpPort -Port ([int]$connectivityConfig.localHaPort) } else { $false }
    botTunnelPortReady = if ($connectivityConfig) { Test-ArtemTcpPort -Port ([int]$connectivityConfig.localBotPort) } else { $false }

    homeAssistantConfigured = if ($readyPayload) { [bool]$readyPayload.integrationsConfigured.homeAssistant } else { $null }
    homeAssistantSource = if ($ha) { [string]$ha.source } else { $null }
    homeAssistantHealth = if ($ha) { [string]$ha.health } else { $null }
    homeAssistantWebSocket = if ($ha) { [bool]$ha.data.transport.websocketConnected } else { $null }
    homeAssistantSnapshotConfirmed = if ($ha) { [bool]$ha.data.transport.snapshotConfirmed } else { $null }

    aliceConfigured = if ($readyPayload) { [bool]$readyPayload.integrationsConfigured.alice } else { $null }
    aliceSource = if ($alice) { [string]$alice.source } else { $null }
    aliceHealth = if ($alice) { [string]$alice.health } else { $null }

    avalarMainConfigured = if ($readyPayload) { [bool]$readyPayload.integrationsConfigured.avalarMain } else { $null }
    avalarMainSource = if ($avalarMain) { [string]$avalarMain.source } else { $null }
    avalarMainHealth = if ($avalarMain) { [string]$avalarMain.health } else { $null }
    avalarStageConfigured = if ($readyPayload) { [bool]$readyPayload.integrationsConfigured.avalarStage } else { $null }
    avalarStageSource = if ($avalarStage) { [string]$avalarStage.source } else { $null }
    avalarStageHealth = if ($avalarStage) { [string]$avalarStage.health } else { $null }
    avalarSshDetails = if ($readyPayload) { [bool]$readyPayload.integrationsConfigured.avalarSshDetails } else { $null }

    observedAt = if ($state) { $state.observedAt } else { $null }
    logs = $paths.Logs
}

if ($Json) {
    $status | ConvertTo-Json -Depth 6
}
else {
    $status.GetEnumerator() | ForEach-Object {
        "{0,-32} {1}" -f $_.Key, $_.Value
    }
}
