param(
    [Parameter(Mandatory)][string]$HostName,
    [Parameter(Mandatory)][string]$UserName,
    [ValidateRange(1, 65535)][int]$Port = 22,
    [string]$SshAlias = "ha-control-tunnel",
    [ValidateRange(1024, 65535)][int]$LocalHaPort = 18123,
    [ValidateRange(1, 65535)][int]$RemoteHaPort = 18123,
    [ValidateRange(1024, 65535)][int]$LocalBotPort = 18088,
    [ValidateRange(1, 65535)][int]$RemoteBotPort = 18088,
    [switch]$StartNow
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "connectivity-common.ps1")

foreach ($value in @($HostName, $UserName, $SshAlias)) {
    if ($value -notmatch '^[A-Za-z0-9._@:-]+$') {
        throw "Unsafe SSH connection value: $value"
    }
}
if ($LocalHaPort -eq $LocalBotPort) {
    throw "Home Assistant and Alice local ports must be different"
}

Update-ArtemProcessPath
$ssh = Get-Command ssh.exe -ErrorAction Stop
$sshKeygen = Get-Command ssh-keygen.exe -ErrorAction Stop
$paths = Get-ArtemConnectivityPaths
Initialize-ArtemRuntimeDirectories -Paths $paths.Runtime

$sshDirectory = Join-Path $env:USERPROFILE ".ssh"
New-Item -ItemType Directory -Force -Path $sshDirectory | Out-Null
$keyPath = Join-Path $sshDirectory "artem_control_center_tunnel"
$publicKeyPath = "$keyPath.pub"
$configPath = Join-Path $sshDirectory "config"

if (-not (Test-Path -LiteralPath $keyPath)) {
    & $sshKeygen.Source `
        -q `
        -t ed25519 `
        -f $keyPath `
        -N "" `
        -C "artem-control-center-tunnel@$env:COMPUTERNAME"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $publicKeyPath)) {
        throw "Unable to generate the dedicated connectivity SSH key"
    }
    Write-Host "Generated dedicated connectivity key: $keyPath"
}
else {
    if (-not (Test-Path -LiteralPath $publicKeyPath)) {
        throw "Connectivity private key exists but its public key is missing"
    }
    Write-Host "Existing dedicated connectivity key preserved: $keyPath"
}

$keyForConfig = $keyPath.Replace("\", "/")
$beginMarker = "# BEGIN ARTEM CONTROL CENTER CONNECTIVITY"
$endMarker = "# END ARTEM CONTROL CENTER CONNECTIVITY"
$block = @"
$beginMarker
Host $SshAlias
    HostName $HostName
    User $UserName
    Port $Port
    IdentityFile $keyForConfig
    IdentitiesOnly yes
    BatchMode yes
    RequestTTY no
    StrictHostKeyChecking accept-new
    LocalForward 127.0.0.1:$LocalHaPort 127.0.0.1:$RemoteHaPort
    LocalForward 127.0.0.1:$LocalBotPort 127.0.0.1:$RemoteBotPort
$endMarker
"@

$existing = if (Test-Path -LiteralPath $configPath) {
    Get-Content -LiteralPath $configPath -Raw
}
else {
    ""
}
$pattern = "(?ms)^" + [regex]::Escape($beginMarker) + ".*?^" + [regex]::Escape($endMarker) + "\r?\n?"
$withoutOldBlock = [regex]::Replace($existing, $pattern, "").TrimEnd()
$nextConfig = if ($withoutOldBlock) { "$withoutOldBlock`r`n`r`n$block" } else { $block }
Set-Content -LiteralPath $configPath -Value $nextConfig -Encoding ASCII

$config = [ordered]@{
    schemaVersion = 1
    sshAlias = $SshAlias
    localHaPort = $LocalHaPort
    remoteHaPort = $RemoteHaPort
    localBotPort = $LocalBotPort
    remoteBotPort = $RemoteBotPort
    installedAt = [DateTime]::UtcNow.ToString("o")
}
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $paths.Config -Encoding ASCII

foreach ($protectedPath in @($keyPath, $publicKeyPath, $configPath, $paths.Config)) {
    Protect-ArtemConnectivityFile -Path $protectedPath
}

Stop-ArtemConnectivityProcesses -Paths $paths -Manual $false
$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($paths.StartScript)`" -AutoStart"
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument $taskArguments `
    -WorkingDirectory $paths.Runtime.RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUserSid
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUserSid `
    -LogonType Interactive `
    -RunLevel Limited
Register-ScheduledTask `
    -TaskName $paths.TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

$desktop = [Environment]::GetFolderPath("Desktop")
$configureProductionScript = Join-Path $PSScriptRoot "configure-home-production.ps1"
@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.StartScript)"
"@ | Set-Content -LiteralPath (Join-Path $desktop "Start Control Center Connectivity.cmd") -Encoding ASCII
@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.StopScript)"
"@ | Set-Content -LiteralPath (Join-Path $desktop "Stop Control Center Connectivity.cmd") -Encoding ASCII
@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$($paths.StatusScript)"
pause
"@ | Set-Content -LiteralPath (Join-Path $desktop "Control Center Connectivity Status.cmd") -Encoding ASCII
@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$configureProductionScript"
if errorlevel 1 pause
"@ | Set-Content -LiteralPath (Join-Path $desktop "Configure Home Production.cmd") -Encoding ASCII

$publicKeyCopy = Join-Path $paths.Runtime.RuntimeRoot "connectivity-public-key.txt"
Copy-Item -LiteralPath $publicKeyPath -Destination $publicKeyCopy -Force
Protect-ArtemConnectivityFile -Path $publicKeyCopy

if ($StartNow) {
    Remove-Item -LiteralPath $paths.StopMarker -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $paths.TaskName
}
else {
    Write-ArtemConnectivityStopMarker -Paths $paths
}

Write-Host ""
Write-Host "Private connectivity tunnel installed."
Write-Host "Scheduled task: $($paths.TaskName)"
Write-Host "SSH alias: $SshAlias"
Write-Host "Home Assistant local forward: 127.0.0.1:$LocalHaPort"
Write-Host "AliceTG Bot local forward: 127.0.0.1:$LocalBotPort"
Write-Host "Public key for the VPS: $publicKeyCopy"
Write-Host "Desktop helper: Configure Home Production.cmd"
if (-not $StartNow) {
    Write-Host "Autostart is paused until the public key is installed on the VPS and the tunnel is started manually."
}
