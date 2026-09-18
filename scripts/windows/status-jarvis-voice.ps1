param([switch]$Json)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")
$paths = Get-ArtemRuntimePaths
$voice = Get-ArtemJarvisVoicePaths -Paths $paths
$task = Get-ScheduledTask -TaskName $voice.TaskName -ErrorAction SilentlyContinue
$consoleSession = (Get-Process -Name explorer -ErrorAction SilentlyContinue | Select-Object -First 1).SessionId
$workers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq "python.exe" -and $_.CommandLine -like "*$($voice.WorkerModule)*" })
$workerSessionIds = @($workers | ForEach-Object { $_.SessionId })
$wrongSession = @($workerSessionIds | Where-Object { $_ -eq 0 -or $_ -ne $consoleSession }).Count -gt 0
$healthy = ($workers.Count -eq 1 -and -not $wrongSession -and $consoleSession -ne 0)
$status = [ordered]@{
    configured = Test-Path -LiteralPath $voice.Config
    installed = $null -ne $task
    taskState = if ($task) { [string]$task.State } else { $null }
    workerCount = $workers.Count
    workerSessionIds = $workerSessionIds
    consoleSessionId = $consoleSession
    wrongSession = $wrongSession
    healthy = $healthy
}
if ($Json) { $status | ConvertTo-Json -Depth 4 } else { $status.GetEnumerator() | ForEach-Object { "{0,-20} {1}" -f $_.Key, $_.Value } }
