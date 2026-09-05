#requires -RunAsAdministrator
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "coffee-upload-ingress-common.ps1")

Remove-ArtemCoffeeUploadIngressFirewallRule
Write-Host "Coffee upload ingress firewall rule removed."
