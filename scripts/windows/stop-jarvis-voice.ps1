$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
$voice = Get-ArtemJarvisVoicePaths -Paths (Get-ArtemRuntimePaths)
$task = Get-ScheduledTask -TaskName $voice.TaskName -ErrorAction SilentlyContinue
if ($null -ne $task -and $task.State -eq "Running") { Stop-ScheduledTask -TaskName $voice.TaskName }
