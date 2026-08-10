$ErrorActionPreference = "Stop"

function Read-ScriptText {
    param([Parameter(Mandatory)][string]$Name)
    return Get-Content -LiteralPath (Join-Path $PSScriptRoot $Name) -Raw
}

$installer = Read-ScriptText "install-connectivity-tunnel.ps1"
$starter = Read-ScriptText "start-connectivity-tunnel.ps1"
$stopper = Read-ScriptText "stop-connectivity-tunnel.ps1"
$restarter = Read-ScriptText "restart-connectivity-tunnel.ps1"
$common = Read-ScriptText "connectivity-common.ps1"
$configurator = Read-ScriptText "configure-home-production.ps1"
$status = Read-ScriptText "status-production.ps1"

foreach ($required in @(
    "artem_control_center_tunnel",
    "IdentityFile",
    "IdentitiesOnly yes",
    "BatchMode yes",
    "LocalForward 127.0.0.1:`$LocalHaPort 127.0.0.1:`$RemoteHaPort",
    "LocalForward 127.0.0.1:`$LocalBotPort 127.0.0.1:`$RemoteBotPort",
    "Artem Control Center Connectivity"
)) {
    if ($installer -notlike "*$required*") {
        throw "Connectivity installer contract is missing: $required"
    }
}
if ($installer -match '\$env:USERDOMAIN') {
    throw "Connectivity task must use the current user SID, not USERDOMAIN"
}
if ($installer -notmatch 'New-ScheduledTaskPrincipal[\s\S]*-UserId\s+\$currentUserSid') {
    throw "Connectivity task must register with the resolved current user SID"
}

foreach ($required in @(
    '"-N"',
    '"-T"',
    'ExitOnForwardFailure=yes',
    'ServerAliveInterval=30',
    'ServerAliveCountMax=3',
    'Test-ArtemConnectivityReady',
    'Get-RetryDelaySeconds',
    'Get-Random',
    'Status "retrying"',
    'consecutiveFailures'
)) {
    if ($starter -notlike "*$required*") {
        throw "Connectivity supervisor contract is missing: $required"
    }
}
if ($starter -like '*restart_budget_exhausted*' -or $starter -match 'attempts\.Count\s+-ge') {
    throw "Connectivity supervisor must not permanently exit after a finite network retry budget"
}

foreach ($required in @(
    'Stop-ScheduledTask -TaskName $paths.TaskName',
    'Stop-ArtemConnectivityProcesses -Paths $paths -Manual $false',
    'Start-ScheduledTask -TaskName $paths.TaskName',
    'system.connectivity.restart'
)) {
    if ($restarter -notlike "*$required*") {
        throw "Panel-native connectivity restart helper is missing: $required"
    }
}
if ($restarter -notmatch '(?s)^param\(\s*\[switch\]\$Json\s*\)') {
    throw "Connectivity restart helper may expose only the fixed Json output switch"
}

$combinedProcessControl = "$common`n$starter`n$stopper`n$restarter"
if ($combinedProcessControl -match 'Get-Process\s+(ssh|powershell)' -or
    $combinedProcessControl -match 'taskkill\.exe\s+/IM') {
    throw "Connectivity controls must never kill SSH or PowerShell by image name"
}
foreach ($required in @(
    "sshPid",
    "supervisorPid",
    "Stop-Process -Id",
    "Test-ArtemConnectivitySshProcess",
    "CommandLine",
    "sshAlias"
)) {
    if ($combinedProcessControl -notlike "*$required*") {
        throw "Connectivity process ownership contract is missing: $required"
    }
}

foreach ($required in @(
    'PANEL_AGENT_MODE = "production"',
    'PANEL_HA_URL',
    'PANEL_HA_TOKEN',
    'PANEL_ALICE_HEALTH_URL',
    'PANEL_ALICE_BASE_URL',
    'PANEL_ALICE_DETAILS_TOKEN',
    'PANEL_ALICE_CONTROL_CENTER_TOKEN',
    'PANEL_WRITES_ENABLED = "false"',
    'PANEL_COFFEE_ACTIONS_ENABLED = "false"',
    'Wait-LivePanelIntegrations',
    'websocketConnected',
    'snapshotConfirmed',
    'production-backup'
)) {
    if ($configurator -notlike "*$required*") {
        throw "Production integration configurator contract is missing: $required"
    }
}
if ($configurator -match 'Write-Host[^\r\n]*(haToken|aliceControlToken|aliceDetailsToken)') {
    throw "Production integration configurator must never print secret variables"
}
$falseWritePosition = $configurator.IndexOf('PANEL_WRITES_ENABLED = "false"')
$trueWritePosition = $configurator.IndexOf('Set-RuntimeEnvEntry -Key $key -Value "true"')
if ($falseWritePosition -lt 0 -or $trueWritePosition -le $falseWritePosition) {
    throw "Production integration must verify read-only connectivity before enabling writes"
}

foreach ($required in @(
    "connectivityReady",
    "homeAssistantWebSocket",
    "homeAssistantSnapshotConfirmed",
    "aliceHealth",
    "avalarMainHealth",
    "avalarStageHealth"
)) {
    if ($status -notlike "*$required*") {
        throw "Unified status contract is missing: $required"
    }
}

Write-Host "Validated resilient private connectivity, scoped restart ownership, fail-closed production rollout and unified status contracts."
