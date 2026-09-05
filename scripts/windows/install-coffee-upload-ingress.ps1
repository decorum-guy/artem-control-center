#requires -RunAsAdministrator
param(
    [ValidateRange(1024, 65535)][int]$Port = 8788,
    [string]$ProgramPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "coffee-upload-ingress-common.ps1")
. (Join-Path $PSScriptRoot "runtime-common.ps1")

Assert-ArtemCoffeeUploadIngressPort -Port $Port
$paths = Get-ArtemRuntimePaths
if ([string]::IsNullOrWhiteSpace($ProgramPath)) {
    $revision = Get-ArtemCheckoutRevision -Paths $paths
    $ProgramPath = Get-ArtemRuntimePythonPath -Paths $paths -Revision $revision
}
$ProgramPath = [IO.Path]::GetFullPath($ProgramPath)
if (-not (Test-Path -LiteralPath $ProgramPath -PathType Leaf)) {
    throw "Coffee upload ingress program was not found: $ProgramPath"
}

Remove-ArtemCoffeeUploadIngressFirewallRule
New-NetFirewallRule `
    -DisplayName (Get-ArtemCoffeeUploadIngressFirewallRuleName) `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Program $ProgramPath `
    -Profile Private `
    -RemoteAddress LocalSubnet `
    -Description "Private-LAN-only Coffee Diary photo upload ingress; Panel Agent remains loopback-only." | Out-Null

Write-Host "Coffee upload ingress firewall rule installed for the private LAN."
Write-Host "Port: $Port"
Write-Host "Program: $ProgramPath"
