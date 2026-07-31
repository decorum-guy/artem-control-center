param(
    [string]$HostName = "server141.hosting.reg.ru",
    [string]$UserName = "u3520338",
    [ValidateRange(1, 65535)][int]$Port = 22,
    [string]$StatusAlias = "avalar-status",
    [string]$ActionAlias = "avalar-control"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

foreach ($value in @($HostName, $UserName, $StatusAlias, $ActionAlias)) {
    if ($value -notmatch '^[A-Za-z0-9._@-]+$') {
        throw "Unsafe AVALAR SSH connection value: $value"
    }
}
if ($StatusAlias -eq $ActionAlias) {
    throw "Status and action SSH aliases must be different"
}

function Protect-ArtemIdentityFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path `
        /inheritance:r `
        /grant:r `
        "*${currentUserSid}:(F)" `
        "*S-1-5-18:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict ACL for $Path"
    }
}

function ConvertTo-NativeProcessArgument {
    param([AllowEmptyString()][Parameter(Mandatory)][string]$Value)

    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw "Native process arguments must not contain quotes or line breaks"
    }
    if ($Value.Length -eq 0) {
        return '""'
    }
    if ($Value -match '\s') {
        if ($Value.EndsWith('\')) {
            throw "Quoted native process arguments must not end with a backslash"
        }
        return '"' + $Value + '"'
    }
    return $Value
}

function Invoke-SshKeygen {
    param(
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $script:SshKeygen
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    # Windows PowerShell 5.1 drops an empty native argument in a direct
    # invocation such as: ssh-keygen -N "". Build the command line explicitly
    # on .NET Framework, while using ArgumentList when the runtime provides it.
    if ($startInfo.PSObject.Properties.Name -contains "ArgumentList") {
        foreach ($argument in $Arguments) {
            [void]$startInfo.ArgumentList.Add($argument)
        }
    }
    else {
        $startInfo.Arguments = (
            $Arguments |
                ForEach-Object { ConvertTo-NativeProcessArgument -Value $_ }
        ) -join " "
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "ssh-keygen process did not start"
        }
        $standardOutput = $process.StandardOutput.ReadToEnd()
        $standardError = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $standardOutput
            StandardError = $standardError
        }
    }
    finally {
        $process.Dispose()
    }
}

function Ensure-Ed25519Identity {
    param(
        [Parameter(Mandatory)][string]$KeyPath,
        [Parameter(Mandatory)][string]$Comment
    )
    $publicKeyPath = "$KeyPath.pub"
    if (-not (Test-Path -LiteralPath $KeyPath)) {
        $result = Invoke-SshKeygen -Arguments @(
            "-q",
            "-t", "ed25519",
            "-f", $KeyPath,
            "-N", "",
            "-C", $Comment
        )
        if ($result.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $publicKeyPath)) {
            $diagnostic = $result.StandardError.Trim()
            if (-not $diagnostic) {
                $diagnostic = "ssh-keygen exited with code $($result.ExitCode)"
            }
            throw "Unable to generate AVALAR SSH identity: $KeyPath. $diagnostic"
        }
    }
    elseif (-not (Test-Path -LiteralPath $publicKeyPath)) {
        throw "AVALAR private key exists but public key is missing: $KeyPath"
    }
    Protect-ArtemIdentityFile -Path $KeyPath
    Protect-ArtemIdentityFile -Path $publicKeyPath
    return $publicKeyPath
}

Update-ArtemProcessPath
$null = Get-Command ssh.exe -ErrorAction Stop
$script:SshKeygen = (Get-Command ssh-keygen.exe -ErrorAction Stop).Source
$paths = Get-ArtemRuntimePaths
Initialize-ArtemRuntimeDirectories -Paths $paths
$sshDirectory = Join-Path $env:USERPROFILE ".ssh"
New-Item -ItemType Directory -Force -Path $sshDirectory | Out-Null

$statusKey = Join-Path $sshDirectory "artem_control_center_avalar_status"
$actionKey = Join-Path $sshDirectory "artem_control_center_avalar_actions"
$statusPublic = Ensure-Ed25519Identity `
    -KeyPath $statusKey `
    -Comment "artem-control-center-avalar-status@$env:COMPUTERNAME"
$actionPublic = Ensure-Ed25519Identity `
    -KeyPath $actionKey `
    -Comment "artem-control-center-avalar-actions@$env:COMPUTERNAME"

$configPath = Join-Path $sshDirectory "config"
$beginMarker = "# BEGIN ARTEM CONTROL CENTER AVALAR IDENTITIES"
$endMarker = "# END ARTEM CONTROL CENTER AVALAR IDENTITIES"
$statusKeyForConfig = $statusKey.Replace("\", "/")
$actionKeyForConfig = $actionKey.Replace("\", "/")
$block = @"
$beginMarker
Host $StatusAlias
    HostName $HostName
    User $UserName
    Port $Port
    IdentityFile $statusKeyForConfig
    IdentitiesOnly yes
    BatchMode yes
    RequestTTY no
    StrictHostKeyChecking accept-new

Host $ActionAlias
    HostName $HostName
    User $UserName
    Port $Port
    IdentityFile $actionKeyForConfig
    IdentitiesOnly yes
    BatchMode yes
    RequestTTY no
    StrictHostKeyChecking accept-new
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
Protect-ArtemIdentityFile -Path $configPath

$statusPublicCopy = Join-Path $paths.RuntimeRoot "avalar-status-public-key.txt"
$actionPublicCopy = Join-Path $paths.RuntimeRoot "avalar-action-public-key.txt"
Copy-Item -LiteralPath $statusPublic -Destination $statusPublicCopy -Force
Copy-Item -LiteralPath $actionPublic -Destination $actionPublicCopy -Force
Protect-ArtemIdentityFile -Path $statusPublicCopy
Protect-ArtemIdentityFile -Path $actionPublicCopy

Write-Host ""
Write-Host "Separate AVALAR SSH identities installed."
Write-Host "Status alias: $StatusAlias"
Write-Host "Action alias: $ActionAlias"
Write-Host "Status public key: $statusPublicCopy"
Write-Host "Action public key: $actionPublicCopy"
Write-Host "Private keys remain only in the panel account SSH directory."
Write-Host "Install the two public keys on REG.RU through the separate status/actions key installer."
