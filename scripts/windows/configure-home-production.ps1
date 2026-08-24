param(
    [ValidateRange(1024, 65535)][int]$HaPort = 18123,
    [ValidateRange(1024, 65535)][int]$BotPort = 18088,
    [switch]$KeepWritesDisabled,
    [switch]$SkipRuntimeRestart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "connectivity-common.ps1")

$script:RuntimeEnvLines = [System.Collections.Generic.List[string]]::new()

function ConvertTo-PlainText {
    param([Parameter(Mandatory)][Security.SecureString]$SecureValue)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Read-RequiredSecret {
    param([Parameter(Mandatory)][string]$Prompt)
    $secure = Read-Host $Prompt -AsSecureString
    $plain = ConvertTo-PlainText -SecureValue $secure
    if ([string]::IsNullOrWhiteSpace($plain)) {
        throw "$Prompt cannot be empty"
    }
    return $plain.Trim()
}

function Set-RuntimeEnvEntry {
    param(
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$Value
    )
    if ($Key -notmatch '^[A-Z_][A-Z0-9_]*$') {
        throw "Invalid environment key: $Key"
    }
    if ($Value -match "[`r`n]") {
        throw "Environment values must be single-line"
    }
    $pattern = "^\s*" + [regex]::Escape($Key) + "\s*="
    $found = $false
    for ($index = $script:RuntimeEnvLines.Count - 1; $index -ge 0; $index--) {
        if ($script:RuntimeEnvLines[$index] -match $pattern) {
            if (-not $found) {
                $script:RuntimeEnvLines[$index] = "$Key=$Value"
                $found = $true
            }
            else {
                $script:RuntimeEnvLines.RemoveAt($index)
            }
        }
    }
    if (-not $found) {
        [void]$script:RuntimeEnvLines.Add("$Key=$Value")
    }
}

function Protect-RuntimeConfiguration {
    param([Parameter(Mandatory)][string]$Path)
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path `
        /inheritance:r `
        /grant:r `
        "*${currentUserSid}:(F)" `
        "*S-1-5-18:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict runtime.env ACL"
    }
}

function Write-RuntimeConfiguration {
    param([Parameter(Mandatory)]$Paths)
    $temporary = "$($Paths.RuntimeEnv).$PID.tmp"
    try {
        Set-Content -LiteralPath $temporary -Value $script:RuntimeEnvLines -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $Paths.RuntimeEnv -Force
        Protect-RuntimeConfiguration -Path $Paths.RuntimeEnv
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Restart-ControlCenterRuntime {
    param([Parameter(Mandatory)]$Paths)
    Stop-ArtemRuntime -Paths $Paths -Manual $false
    Remove-Item -LiteralPath $Paths.ManualStop -Force -ErrorAction SilentlyContinue
    & $Paths.StartScript
    if (-not (Wait-ArtemPanelReady -Paths $Paths -TimeoutSeconds 60)) {
        throw "Control Center did not become ready after production integration update"
    }
}

function Test-LivePanelPlanning {
    try {
        $planning = Invoke-RestMethod `
            -Uri "http://127.0.0.1:8787/api/v1/planning/status" `
            -Method Get `
            -TimeoutSec 5
        return (
            $planning.schemaVersion -eq "planning.panel.v1" -and
            -not [string]::IsNullOrWhiteSpace([string]$planning.generatedAt) -and
            $planning.sourceStatus -in @("current", "stale", "offline", "degraded")
        )
    }
    catch {
        return $false
    }
}

function Test-LivePanelIntegrations {
    param([Parameter(Mandatory)]$Paths)
    try {
        $snapshot = Invoke-RestMethod `
            -Uri "http://127.0.0.1:8787/api/v1/snapshot" `
            -Method Get `
            -TimeoutSec 5
        $ha = $snapshot.services | Where-Object { $_.id -eq "home-assistant" } | Select-Object -First 1
        $alice = $snapshot.services | Where-Object { $_.id -eq "alice-tg-bot" } | Select-Object -First 1
        $planningReady = Test-LivePanelPlanning
        return (
            $snapshot.mode -eq "production" -and
            $null -ne $ha -and
            $ha.source -eq "live" -and
            $ha.data.transport.websocketConnected -eq $true -and
            $ha.data.transport.snapshotConfirmed -eq $true -and
            $null -ne $alice -and
            $alice.source -eq "live" -and
            $alice.health -eq "healthy" -and
            $planningReady
        )
    }
    catch {
        return $false
    }
}

function Wait-LivePanelIntegrations {
    param(
        [Parameter(Mandatory)]$Paths,
        [int]$TimeoutSeconds = 75
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-LivePanelIntegrations -Paths $Paths) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Test-AlicePlanningApi {
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter(Mandatory)][string]$InternalSecret,
        [Parameter(Mandatory)][string]$PanelAgentSecret
    )
    try {
        $status = Invoke-RestMethod `
            -Uri "$BaseUrl/internal/planning/v1/status" `
            -Headers @{
                "X-Internal-Secret" = $InternalSecret
                "X-Planning-Audience" = "panel-agent"
                "X-Planning-Secret" = $PanelAgentSecret
            } `
            -Method Get `
            -TimeoutSec 15
        return (
            $status.schemaVersion -eq "planning.v1" -and
            $status.kind -eq "status" -and
            $status.storageStatus -eq "available"
        )
    }
    catch {
        return $false
    }
}

$runtimePaths = Get-ArtemRuntimePaths
$connectivityPaths = Get-ArtemConnectivityPaths
if (-not (Test-Path -LiteralPath $runtimePaths.RuntimeEnv)) {
    throw "runtime.env is missing. Install the production runtime first."
}
if (-not (Test-ArtemConnectivityReady -Paths $connectivityPaths)) {
    throw "Private connectivity is not ready. Start and verify the SSH tunnel first."
}

$haBaseUrl = "http://127.0.0.1:$HaPort"
$botBaseUrl = "http://127.0.0.1:$BotPort"
$haToken = $null
$aliceControlToken = $null
$aliceDetailsToken = $null
$planningPanelSecret = $null
$backupPath = "$($runtimePaths.RuntimeEnv).production-backup"

try {
    $haToken = Read-RequiredSecret -Prompt "Home Assistant long-lived token"
    $aliceControlToken = Read-RequiredSecret -Prompt "AliceTG CONTROL_CENTER_API_TOKEN"
    $aliceDetailsToken = Read-RequiredSecret -Prompt "AliceTG INTERNAL_WEBHOOK_SECRET for health details"
    $planningPanelSecret = Read-RequiredSecret -Prompt "AliceTG PLANNING_PANEL_AGENT_SECRET"

    try {
        $haResponse = Invoke-WebRequest `
            -Uri "$haBaseUrl/api/" `
            -Headers @{ Authorization = "Bearer $haToken" } `
            -UseBasicParsing `
            -TimeoutSec 10
        if ($haResponse.StatusCode -ne 200) { throw "unexpected_status" }
    }
    catch {
        throw "Home Assistant authentication through the private tunnel failed"
    }

    try {
        $liveResponse = Invoke-WebRequest `
            -Uri "$botBaseUrl/health/live" `
            -UseBasicParsing `
            -TimeoutSec 10
        $readyResponse = Invoke-WebRequest `
            -Uri "$botBaseUrl/health/ready" `
            -UseBasicParsing `
            -TimeoutSec 15
        if ($liveResponse.StatusCode -ne 200 -or $readyResponse.StatusCode -ne 200) {
            throw "unexpected_status"
        }
        $null = Invoke-RestMethod `
            -Uri "$botBaseUrl/health/details" `
            -Headers @{ "X-Internal-Secret" = $aliceDetailsToken } `
            -Method Get `
            -TimeoutSec 10
        $null = Invoke-RestMethod `
            -Uri "$botBaseUrl/internal/control-center/coffee/timing" `
            -Headers @{ Authorization = "Bearer $aliceControlToken" } `
            -Method Get `
            -TimeoutSec 15
    }
    catch {
        throw "AliceTG health or Control Center API verification through the private tunnel failed"
    }

    if (-not (Test-AlicePlanningApi `
        -BaseUrl $botBaseUrl `
        -InternalSecret $aliceDetailsToken `
        -PanelAgentSecret $planningPanelSecret)) {
        throw "AliceTG Planning panel-agent authentication through the private tunnel failed"
    }

    Copy-Item -LiteralPath $runtimePaths.RuntimeEnv -Destination $backupPath -Force
    Protect-RuntimeConfiguration -Path $backupPath
    foreach ($line in (Get-Content -LiteralPath $runtimePaths.RuntimeEnv)) {
        [void]$script:RuntimeEnvLines.Add([string]$line)
    }

    $entries = [ordered]@{
        PANEL_AGENT_MODE = "production"
        PANEL_HA_URL = $haBaseUrl
        PANEL_HA_TOKEN = $haToken
        PANEL_HA_STALE_AFTER_SECONDS = "90"
        PANEL_STATE_CACHE_PATH = (Join-Path $runtimePaths.RuntimeRoot "panel-state-cache.json")
        PANEL_ALICE_HEALTH_URL = $botBaseUrl
        PANEL_ALICE_DETAILS_TOKEN = $aliceDetailsToken
        PANEL_ALICE_BASE_URL = $botBaseUrl
        PANEL_ALICE_CONTROL_CENTER_TOKEN = $aliceControlToken
        PANEL_PLANNING_ENABLED = "true"
        PANEL_PLANNING_BASE_URL = $botBaseUrl
        PANEL_PLANNING_INTERNAL_SECRET = $aliceDetailsToken
        PANEL_PLANNING_SECRET = $planningPanelSecret
        PANEL_WRITES_ENABLED = "false"
        PANEL_COFFEE_ACTIONS_ENABLED = "false"
        PANEL_COFFEE_TIMING_WRITES_ENABLED = "false"
        PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED = "false"
    }
    foreach ($entry in $entries.GetEnumerator()) {
        Set-RuntimeEnvEntry -Key ([string]$entry.Key) -Value ([string]$entry.Value)
    }
    Write-RuntimeConfiguration -Paths $runtimePaths

    if (-not $SkipRuntimeRestart) {
        Restart-ControlCenterRuntime -Paths $runtimePaths
        if (-not (Wait-LivePanelIntegrations -Paths $runtimePaths)) {
            throw "Panel Agent did not confirm live Home Assistant WebSocket and AliceTG readiness"
        }
    }

    if (-not $KeepWritesDisabled) {
        foreach ($key in @(
            "PANEL_WRITES_ENABLED",
            "PANEL_COFFEE_ACTIONS_ENABLED",
            "PANEL_COFFEE_TIMING_WRITES_ENABLED",
            "PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED"
        )) {
            Set-RuntimeEnvEntry -Key $key -Value "true"
        }
        Write-RuntimeConfiguration -Paths $runtimePaths
        if (-not $SkipRuntimeRestart) {
            Restart-ControlCenterRuntime -Paths $runtimePaths
            if (-not (Wait-LivePanelIntegrations -Paths $runtimePaths)) {
                throw "Live integrations were lost after enabling access-controlled coffee writes"
            }
        }
    }

    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "Home Assistant and AliceTG production connectivity configured."
    Write-Host "Panel mode: production"
    Write-Host "Home Assistant: $haBaseUrl"
    Write-Host "AliceTG Bot: $botBaseUrl"
    Write-Host "Planning: authenticated panel-agent boundary enabled"
    Write-Host "Coffee writes: $(if ($KeepWritesDisabled) { 'disabled' } else { 'enabled behind access policy' })"
    Write-Host "No token was printed or written to Git."
}
catch {
    if (Test-Path -LiteralPath $backupPath) {
        Copy-Item -LiteralPath $backupPath -Destination $runtimePaths.RuntimeEnv -Force
        Protect-RuntimeConfiguration -Path $runtimePaths.RuntimeEnv
        Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        if (-not $SkipRuntimeRestart) {
            try { Restart-ControlCenterRuntime -Paths $runtimePaths } catch { }
        }
    }
    throw
}
finally {
    $haToken = $null
    $aliceControlToken = $null
    $aliceDetailsToken = $null
    $planningPanelSecret = $null
}
