param(
    [ValidateSet("install", "status", "restart", "uninstall")]
    [string]$Action = "install",
    [string]$ListenAddress = "0.0.0.0",
    [ValidateRange(1024, 65535)]
    [int]$Port = 8769,
    [string]$FirewallRemoteAddress = "LocalSubnet",
    [ValidateSet("Private", "Domain", "Public")]
    [string]$FirewallProfile = "Private"
)

$ErrorActionPreference = "Stop"

$taskName = "Artem Control Center ROG G703 Companion"
$firewallRuleName = "Artem Control Center ROG G703 Companion"
$installRoot = Join-Path $env:ProgramData "ArtemControlCenter\RogG703Companion"
$configPath = Join-Path $installRoot "companion.json"
$secretPath = Join-Path $installRoot "companion.secret"
$companionPath = Join-Path $installRoot "rog_g703_companion.py"
$sourcePath = Join-Path $PSScriptRoot "rog_g703_companion.py"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this ROG G703 companion bootstrap from an elevated PowerShell window."
    }
}

function Test-IPv4Address {
    param([Parameter(Mandatory)][string]$Value)
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed)) { return $false }
    return $parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
}

function Assert-ListenAddress {
    if (-not (Test-IPv4Address -Value $ListenAddress)) {
        throw "ListenAddress must be an IPv4 address."
    }
}

function Assert-FirewallRemoteAddress {
    if ($FirewallRemoteAddress -eq "LocalSubnet") { return }
    if ($FirewallRemoteAddress -notmatch '^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$') {
        throw "FirewallRemoteAddress must be LocalSubnet or an IPv4 address/CIDR."
    }
}

function Protect-Path {
    param([Parameter(Mandatory)][string]$Path)
    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $aclArguments = @(
        $Path,
        "/inheritance:r",
        "/grant:r",
        "*${currentUserSid}:(F)",
        "*S-1-5-18:(F)"
    )
    & icacls.exe @aclArguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to protect companion path: $Path"
    }
}

function New-CompanionSecret {
    $bytes = New-Object byte[] 48
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Get-PythonCommand {
    $candidates = @(
        @{ Name = "python.exe"; VersionArguments = @("--version"); PrefixArguments = @() },
        @{ Name = "py.exe"; VersionArguments = @("-3", "--version"); PrefixArguments = @("-3") }
    )
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate.Name -ErrorAction SilentlyContinue
        if ($null -eq $command) { continue }
        $version = (& $command.Source @($candidate.VersionArguments) 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $version -notmatch "Python\s+3\.(\d+)") { continue }
        if ([int]$Matches[1] -lt 10) { continue }
        return [pscustomobject]@{
            Path = $command.Source
            PrefixArguments = @($candidate.PrefixArguments)
        }
    }
    throw "Python 3.10 or newer is required. Install Python locally on the ASUS, then rerun this bootstrap; no runtime is downloaded by this script."
}

function Read-CompanionConfig {
    if (-not (Test-Path -LiteralPath $configPath)) { return $null }
    try {
        return Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Companion configuration is invalid: $configPath"
    }
}

function Get-CompanionSecret {
    if (-not (Test-Path -LiteralPath $secretPath)) {
        return $null
    }
    $secret = (Get-Content -LiteralPath $secretPath -Raw).Trim()
    if ($secret.Length -lt 32 -or $secret -match "\s") {
        throw "Companion secret is invalid: $secretPath"
    }
    return $secret
}

function Write-CompanionConfig {
    param(
        [Parameter(Mandatory)]$Python,
        [Parameter(Mandatory)][string]$Secret
    )
    New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $companionPath -Force
    Set-Content -LiteralPath $secretPath -Value $Secret -Encoding ASCII -NoNewline
    $configuration = [ordered]@{
        schemaVersion = 1
        listenAddress = $ListenAddress
        port = $Port
        secretFile = $secretPath
        python = $Python.Path
    }
    $configuration | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8
    Protect-Path -Path $installRoot
    Protect-Path -Path $configPath
    Protect-Path -Path $secretPath
    Protect-Path -Path $companionPath
}

function Get-QuotedArgument {
    param([Parameter(Mandatory)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Register-CompanionTask {
    param([Parameter(Mandatory)]$Python)
    $arguments = @(
        @($Python.PrefixArguments)
        "-u"
        $companionPath
        "-ConfigPath"
        $configPath
    ) | ForEach-Object { Get-QuotedArgument -Value ([string]$_) }
    $taskAction = New-ScheduledTaskAction `
        -Execute $Python.Path `
        -Argument ($arguments -join " ") `
        -WorkingDirectory $installRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal `
        -UserId "SYSTEM" `
        -LogonType ServiceAccount `
        -RunLevel Highest
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $taskAction `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Force | Out-Null
}

function Configure-CompanionFirewall {
    $localAddress = if ($ListenAddress -eq "0.0.0.0") { "Any" } else { $ListenAddress }
    Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule `
        -DisplayName $firewallRuleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $Port `
        -LocalAddress $localAddress `
        -RemoteAddress $FirewallRemoteAddress `
        -Profile $FirewallProfile `
        -Description "LAN-only authenticated ROG G703 health and hibernate companion" |
        Out-Null
}

function Get-HealthResponse {
    param(
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][int]$PortNumber,
        [Parameter(Mandatory)][string]$Address
    )
    $headers = @{ Authorization = "Bearer $Secret" }
    $response = Invoke-WebRequest `
        -Uri "http://$Address`:$PortNumber/health" `
        -Method Get `
        -Headers $headers `
        -UseBasicParsing `
        -TimeoutSec 5
    if ($response.StatusCode -ne 200) {
        throw "Companion health returned HTTP $($response.StatusCode)."
    }
    $payload = $response.Content | ConvertFrom-Json
    if (-not $payload.ok -or $payload.status -ne "online") {
        throw "Companion health did not confirm online state."
    }
    return $payload
}

function Wait-CompanionHealth {
    param(
        [Parameter(Mandatory)][string]$Secret,
        [Parameter(Mandatory)][int]$PortNumber,
        [Parameter(Mandatory)][string]$Address
    )
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            return Get-HealthResponse -Secret $Secret -PortNumber $PortNumber -Address $Address
        }
        catch {
            Start-Sleep -Milliseconds 250
        }
    }
    throw "Companion task started but local health did not become ready."
}

function Invoke-Install {
    Assert-ListenAddress
    Assert-FirewallRemoteAddress
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "Companion source is missing: $sourcePath"
    }
    if ($null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
    }
    $python = Get-PythonCommand
    $existingSecret = Get-CompanionSecret
    $secret = if ($existingSecret) { $existingSecret } else { New-CompanionSecret }
    Write-CompanionConfig -Python $python -Secret $secret
    Configure-CompanionFirewall
    Register-CompanionTask -Python $python
    Start-ScheduledTask -TaskName $taskName
    $null = Wait-CompanionHealth -Secret $secret -PortNumber $Port -Address "127.0.0.1"
    Write-Host "ROG G703 companion installed and local health confirmed."
    Write-Host "Task: $taskName"
    Write-Host "Listen address: $ListenAddress`:$Port"
    Write-Host "Firewall scope: $FirewallProfile / $FirewallRemoteAddress"
    Write-Host "Secret path (not printed): $secretPath"
}

function Invoke-Status {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $configuration = Read-CompanionConfig
    $secret = Get-CompanionSecret
    $health = $null
    if ($secret -and $configuration) {
        $healthAddress = if ([string]$configuration.listenAddress -eq "0.0.0.0") { "127.0.0.1" } else { [string]$configuration.listenAddress }
        try { $health = Get-HealthResponse -Secret $secret -PortNumber ([int]$configuration.port) -Address $healthAddress } catch { $health = $null }
    }
    $firewall = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue
    [ordered]@{
        task = $taskName
        taskState = if ($task) { [string]$task.State } else { "Missing" }
        firewallRule = $null -ne $firewall
        listenAddress = if ($configuration) { [string]$configuration.listenAddress } else { $null }
        port = if ($configuration) { [int]$configuration.port } else { $null }
        localHealth = $null -ne $health -and [bool]$health.ok
        healthStatus = if ($health) { [string]$health.status } else { "unreachable" }
        secretPath = $secretPath
    } | ConvertTo-Json -Depth 4
}

function Invoke-Restart {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        throw "Companion task is not installed. Use -Action install first."
    }
    if ([string]$task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $taskName
        $stopped = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if ($null -eq $task) {
                throw "Companion task disappeared while restarting."
            }
            if ([string]$task.State -ne "Running") {
                $stopped = $true
                break
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not $stopped) {
            throw "Companion task did not stop within the restart timeout."
        }
    }
    Start-ScheduledTask -TaskName $taskName
    $secret = Get-CompanionSecret
    $configuration = Read-CompanionConfig
    $healthAddress = if ([string]$configuration.listenAddress -eq "0.0.0.0") { "127.0.0.1" } else { [string]$configuration.listenAddress }
    $null = Wait-CompanionHealth -Secret $secret -PortNumber ([int]$configuration.port) -Address $healthAddress
    Write-Host "ROG G703 companion restarted and local health confirmed."
}

function Invoke-Uninstall {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $installRoot) {
        Remove-Item -LiteralPath $installRoot -Recurse -Force
    }
    Write-Host "ROG G703 companion task, firewall rule and dedicated runtime files removed."
}

Assert-Administrator
switch ($Action) {
    "install" { Invoke-Install }
    "status" { Invoke-Status }
    "restart" { Invoke-Restart }
    "uninstall" { Invoke-Uninstall }
}
