$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
$voice = Get-ArtemJarvisVoicePaths -Paths $paths
$runtimeEnv = if (Test-Path -LiteralPath $paths.RuntimeEnv) { Get-Content -LiteralPath $paths.RuntimeEnv -Raw } else { "" }
if ($runtimeEnv -notmatch '(?m)^PANEL_JARVIS_VOICE_ENABLED=true\s*$') {
    Write-Host "Jarvis voice remains disabled by local runtime configuration."
    exit 0
}
$task = Get-ScheduledTask -TaskName $voice.TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) { throw "Jarvis voice task is not installed." }
$workers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq "python.exe" -and $_.CommandLine -like "*$($voice.WorkerModule)*" })
if ($workers.Count -gt 1) { throw "Refusing to start duplicate Jarvis voice workers." }
if ($workers.Count -eq 1) { Write-Host "Jarvis voice worker is already running."; exit 0 }
Start-ScheduledTask -TaskName $voice.TaskName
