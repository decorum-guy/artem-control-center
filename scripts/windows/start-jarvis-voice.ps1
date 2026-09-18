$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
$voice = Get-ArtemJarvisVoicePaths -Paths $paths
$configuration = Get-ArtemJarvisVoiceConfiguration -Paths $paths
if (-not $configuration.Enabled) {
    Write-Host "Jarvis voice remains disabled by local runtime configuration."
    exit 0
}
$task = Get-ScheduledTask -TaskName $voice.TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) { throw "Jarvis voice task is not installed." }
$workers = @(Get-ArtemJarvisVoiceWorkers -Voice $voice)
if ($workers.Count -gt 1) { throw "Refusing to start duplicate Jarvis voice workers." }
if ($workers.Count -eq 1) {
    $alignment = Get-ArtemJarvisVoiceSessionAlignment -Workers $workers
    if ($alignment.SessionAligned) { Write-Host "Jarvis voice worker is already running in the active console session."; exit 0 }
    # Request a fresh handoff through the one existing Interactive task instead
    # of accepting Session 0 or another user's interactive desktop as healthy.
    if ($task.State -eq "Running") { Stop-ScheduledTask -TaskName $voice.TaskName }
}
Start-ScheduledTask -TaskName $voice.TaskName
