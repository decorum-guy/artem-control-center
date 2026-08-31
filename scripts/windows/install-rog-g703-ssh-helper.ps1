param(
    [ValidateSet("install", "status", "uninstall")]
    [string]$Action = "install"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installRoot = Join-Path $env:ProgramData "ArtemControlCenter\RogG703Ssh"
$helperPath = Join-Path $installRoot "rog-g703-ssh-helper.ps1"
$sourcePath = Join-Path $PSScriptRoot "rog-g703-ssh-helper.ps1"

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this ROG G703 SSH helper installer from an elevated PowerShell window."
    }
}

function Protect-HelperFiles {
    & icacls.exe $installRoot /inheritance:r | Out-Null
    & icacls.exe $installRoot /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "Users:(OI)(CI)RX" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not apply the ROG SSH helper ACL."
    }
}

function Invoke-Install {
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "ROG SSH helper source is missing."
    }
    New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $helperPath -Force
    Protect-HelperFiles
    Write-Host "ROG G703 SSH helper installed at its fixed ProgramData path."
}

function Invoke-Status {
    [ordered]@{
        helperPath = $helperPath
        installed = Test-Path -LiteralPath $helperPath -PathType Leaf
        fixedOperations = @("health", "sleep", "hibernate")
    } | ConvertTo-Json -Compress
}

function Invoke-Uninstall {
    if (Test-Path -LiteralPath $installRoot) {
        Remove-Item -LiteralPath $installRoot -Recurse -Force
    }
    Write-Host "ROG G703 SSH helper files removed."
}

Assert-Administrator
switch ($Action) {
    "install" { Invoke-Install }
    "status" { Invoke-Status }
    "uninstall" { Invoke-Uninstall }
}
