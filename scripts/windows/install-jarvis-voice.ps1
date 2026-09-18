param([switch]$SkipStart)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
$voice = Get-ArtemJarvisVoicePaths -Paths $paths
foreach ($directory in @($voice.Root, $voice.Config, $voice.Models, $voice.State)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

$python = Join-Path $voice.Venv "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Jarvis voice venv is not provisioned. Install its dedicated runtime before registering the task."
}
$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not (Test-Path -LiteralPath $voice.LauncherScript)) {
    throw "Jarvis voice launcher is missing from this checkout."
}
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$($voice.LauncherScript)`"" -WorkingDirectory $paths.RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUserSid
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $currentUserSid -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $voice.TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
if (-not $SkipStart) {
    & (Join-Path $PSScriptRoot "start-jarvis-voice.ps1")
}
