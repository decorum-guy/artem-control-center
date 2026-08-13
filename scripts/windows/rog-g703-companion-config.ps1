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

function Write-CompanionConfig {
    param(
        [Parameter(Mandatory)][string]$InstallRoot,
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)][string]$SecretPath,
        [Parameter(Mandatory)][string]$CompanionPath,
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$ListenAddress,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)]$Python,
        [Parameter(Mandatory)][string]$Secret
    )
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    Copy-Item -LiteralPath $SourcePath -Destination $CompanionPath -Force
    Set-Content -LiteralPath $SecretPath -Value $Secret -Encoding ASCII -NoNewline
    $configuration = [ordered]@{
        schemaVersion = 1
        listenAddress = $ListenAddress
        port = $Port
        secretFile = $SecretPath
        python = $Python.Path
    }
    $json = $configuration | ConvertTo-Json -Depth 4
    # Windows PowerShell 5.1's Set-Content -Encoding UTF8 emits a BOM.
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($ConfigPath, $json, $utf8NoBom)
    Protect-Path -Path $InstallRoot
    Protect-Path -Path $ConfigPath
    Protect-Path -Path $SecretPath
    Protect-Path -Path $CompanionPath
}
