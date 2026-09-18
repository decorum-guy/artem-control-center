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
$result = Invoke-ArtemJarvisVoiceStartLifecycle `
    -Voice $voice `
    -Workers $workers `
    -TaskState ([string]$task.State) `
    -StopTask { Stop-ScheduledTask -TaskName $voice.TaskName } `
    -StartTask { Start-ScheduledTask -TaskName $voice.TaskName } `
    -WorkerProvider { Get-ArtemJarvisVoiceWorkers -Voice $voice }
if ($result.Action -eq "no-op") {
    Write-Host "Jarvis voice worker is already running in the active console session."
}
