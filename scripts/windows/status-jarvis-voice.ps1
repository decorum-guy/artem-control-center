param([switch]$Json)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
$paths = Get-ArtemRuntimePaths
$voice = Get-ArtemJarvisVoicePaths -Paths $paths
$task = Get-ScheduledTask -TaskName $voice.TaskName -ErrorAction SilentlyContinue
$configuration = Get-ArtemJarvisVoiceConfiguration -Paths $paths
$workers = @(Get-ArtemJarvisVoiceWorkers -Voice $voice)
$alignment = Get-ArtemJarvisVoiceSessionAlignment -Workers $workers
$installed = $null -ne $task -and (Test-Path -LiteralPath $voice.LauncherScript) -and
    (Test-Path -LiteralPath (Join-Path $paths.RepoRoot "scripts\windows\runtime-common.ps1")) -and
    (Test-Path -LiteralPath (Join-Path $voice.Venv "Scripts\python.exe"))
$healthy = $configuration.Enabled -and $configuration.Configured -and $configuration.ModelsReady -and $alignment.SessionAligned
$status = [ordered]@{
    installed = $installed
    enabled = $configuration.Enabled
    configured = $configuration.Configured
    modelsReady = $configuration.ModelsReady
    taskState = if ($task) { [string]$task.State } else { $null }
    workerCount = $alignment.WorkerCount
    workerSessionIds = $alignment.WorkerSessionIds
    consoleSessionId = $alignment.ConsoleSessionId
    sessionAligned = $alignment.SessionAligned
    healthy = $healthy
}
if ($Json) { $status | ConvertTo-Json -Depth 4 } else { $status.GetEnumerator() | ForEach-Object { "{0,-20} {1}" -f $_.Key, $_.Value } }
