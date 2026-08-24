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
$panelStarter = Read-ScriptText "start-production.ps1"
$updater = Read-ScriptText "update-production.ps1"
$desktopHelpers = Read-ScriptText "sync-desktop-helpers.ps1"

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

foreach ($required in @(
    "Start-ArtemConnectivityIfConfigured",
    "Get-ArtemConnectivityConfig",
    "Test-ArtemConnectivitySupervisor",
    "Start-ScheduledTask -TaskName `$connectivity.TaskName",
    "connectivity.StopMarker",
    "Sync-ArtemDesktopHelpers"
)) {
    if ($panelStarter -notlike "*$required*") {
        throw "Panel startup must recover configured private connectivity without overriding manual stop: $required"
    }
}

foreach ($required in @(
    "validation-temp",
    "--basetemp=",
    "-p no:cacheprovider",
    "PYTEST_ADDOPTS",
    "Invoke-IsolatedValidation"
)) {
    if ($updater -notlike "*$required*") {
        throw "Production updater must isolate pytest temp/cache state: $required"
    }
}

foreach ($required in @(
    "Open Control Center.cmd",
    "Update Control Center.cmd",
    "Stop Control Center.cmd",
    "Repair Home Connection.cmd",
    "restart-connectivity-tunnel.ps1"
)) {
    if ($desktopHelpers -notlike "*$required*") {
        throw "Consolidated desktop helper contract is missing: $required"
    }
}
foreach ($obsolete in @(
    "Start Control Center.cmd",
    "Start Control Center Connectivity.cmd",
    "Stop Control Center Connectivity.cmd",
    "Control Center Connectivity Status.cmd",
    "Configure Home Production.cmd"
)) {
    if ($desktopHelpers -notlike "*$obsolete*") {
        throw "Desktop helper cleanup must remove obsolete shortcut: $obsolete"
    }
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
    'PANEL_PLANNING_ENABLED = "true"',
    'PANEL_PLANNING_BASE_URL',
    'PANEL_PLANNING_INTERNAL_SECRET',
    'PANEL_PLANNING_SECRET',
    'Test-AlicePlanningApi',
    '/internal/planning/v1/status',
    'X-Planning-Audience',
    'X-Planning-Secret',
    'Test-LivePanelPlanning',
    '/api/v1/planning/status',
    'planning.panel.v1',
    'generatedAt',
    'sourceStatus',
    '"current"',
    '"stale"',
    '"offline"',
    '"degraded"',
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
if ($configurator -match 'Write-Host[^\r\n]*planningPanelSecret') {
    throw "Production integration configurator must never print the Planning secret variable"
}
if ($configurator -notmatch '(?s)function Test-LivePanelIntegrations.*?Test-LivePanelPlanning') {
    throw "Post-restart live integration verification must include Panel Agent Planning readiness"
}
if ($configurator -match '\.sourceStatus\s+-eq\s+"current"') {
    throw "Panel Agent Planning readiness must not require current provider freshness"
}
if ($configurator -match '(?i)providerStatuses|calendarCount|eventCount|icloud') {
    throw "Panel Agent Planning readiness must not couple production rollout to provider freshness"
}
if ($configurator -notmatch 'Read-RequiredSecret\s+-Prompt\s+"AliceTG PLANNING_PANEL_AGENT_SECRET"') {
    throw "Planning panel-agent secret must use the existing SecureString prompt pattern"
}
if ($configurator -notmatch '\$script:RuntimeEnvLines\.RemoveAt\(\$index\)') {
    throw "Production runtime configuration must remove duplicate environment keys"
}
if ($configurator -notmatch 'Copy-Item -LiteralPath \$backupPath -Destination \$runtimePaths\.RuntimeEnv') {
    throw "Production runtime configuration must restore the protected backup on failure"
}
foreach ($forbidden in @(
    'PANEL_PLANNING_REMINDER_MUTATIONS_ENABLED = "true"',
    'PANEL_PLANNING_TASK_MUTATIONS_ENABLED = "true"',
    'PANEL_PLANNING_CALENDAR_MUTATIONS_ENABLED = "true"'
)) {
    if ($configurator -like "*$forbidden*") {
        throw "Planning read configuration must not enable unrelated mutation gate: $forbidden"
    }
}
$planningVerificationPosition = $configurator.IndexOf('if (-not (Test-AlicePlanningApi')
$planningBackupPosition = $configurator.IndexOf('Copy-Item -LiteralPath $runtimePaths.RuntimeEnv -Destination $backupPath')
$planningWritePosition = $configurator.IndexOf('PANEL_PLANNING_ENABLED = "true"')
if ($planningVerificationPosition -lt 0 -or
    $planningBackupPosition -le $planningVerificationPosition -or
    $planningWritePosition -le $planningVerificationPosition) {
    throw "Planning runtime enablement must follow authenticated panel-agent verification"
}
$falseWritePosition = $configurator.IndexOf('PANEL_WRITES_ENABLED = "false"')
$trueWritePosition = $configurator.IndexOf('Set-RuntimeEnvEntry -Key $key -Value "true"')
if ($falseWritePosition -lt 0 -or $trueWritePosition -le $falseWritePosition) {
    throw "Production integration must verify read-only connectivity before enabling writes"
}
$restartMatches = [regex]::Matches($configurator, 'Restart-ControlCenterRuntime\s+-Paths\s+\$runtimePaths')
$waitMatches = [regex]::Matches($configurator, 'Wait-LivePanelIntegrations\s+-Paths\s+\$runtimePaths')
if ($restartMatches.Count -lt 2 -or $waitMatches.Count -lt 2) {
    throw "Both production runtime restarts must use the bounded live integration wait"
}
for ($index = 0; $index -lt $restartMatches.Count; $index++) {
    $restartEnd = $restartMatches[$index].Index + $restartMatches[$index].Length
    $nextRestart = if ($index + 1 -lt $restartMatches.Count) {
        $restartMatches[$index + 1].Index
    }
    else {
        [int]::MaxValue
    }
    $waitAfterRestart = $waitMatches | Where-Object {
        $_.Index -gt $restartEnd -and $_.Index -lt $nextRestart
    }
    if ($null -eq $waitAfterRestart) {
        throw "Each production runtime restart must be followed by bounded live integration verification"
    }
}
$firstBackupDeletionPosition = $configurator.IndexOf('Remove-Item -LiteralPath $backupPath -Force')
$lastWaitPosition = ($waitMatches | Sort-Object Index | Select-Object -Last 1).Index
if ($firstBackupDeletionPosition -lt 0 -or $firstBackupDeletionPosition -le $lastWaitPosition) {
    throw "Protected runtime backup must remain until both restart verifications pass"
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

Write-Host "Validated resilient private connectivity, startup recovery, clean desktop helpers and isolated update validation."
