param(
    [switch]$Json
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "connectivity-common.ps1")

$paths = Get-ArtemConnectivityPaths
Initialize-ArtemRuntimeDirectories -Paths $paths.Runtime
Update-ArtemProcessPath

$config = Get-ArtemConnectivityConfig -Paths $paths
if ($null -eq $config) {
    throw "Connectivity configuration is missing or invalid. Run install-connectivity-tunnel.ps1."
}

$task = Get-ScheduledTask -TaskName $paths.TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    throw "Connectivity scheduled task is missing. Run install-connectivity-tunnel.ps1."
}

# This is a recovery restart, not a manual stop. Clear the persistent stop marker
# first so the supervised task is allowed to reconnect after it starts.
Remove-Item -LiteralPath $paths.StopMarker -Force -ErrorAction SilentlyContinue

# Stop only the dedicated scheduled task and the exact PIDs owned by its state
# file. Stop-ArtemConnectivityProcesses validates process identity before kill.
try {
    Stop-ScheduledTask -TaskName $paths.TaskName -ErrorAction Stop
}
catch {
    # A task that is already stopped is an acceptable restart starting point.
}
Stop-ArtemConnectivityProcesses -Paths $paths -Manual $false -TimeoutSeconds 3

Start-ScheduledTask -TaskName $paths.TaskName

$result = [ordered]@{
    schemaVersion = 1
    accepted = $true
    action = "system.connectivity.restart"
    requestedAt = [DateTime]::UtcNow.ToString("o")
}

if ($Json) {
    $result | ConvertTo-Json -Compress
}
else {
    Write-Host "Control Center private connectivity restart requested."
}
