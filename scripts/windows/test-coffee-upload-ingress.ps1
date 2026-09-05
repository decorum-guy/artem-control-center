$ErrorActionPreference = "Stop"

function Read-ScriptText {
    param([Parameter(Mandatory)][string]$Name)
    return Get-Content -LiteralPath (Join-Path $PSScriptRoot $Name) -Raw
}

$common = Read-ScriptText "coffee-upload-ingress-common.ps1"
$installer = Read-ScriptText "install-coffee-upload-ingress.ps1"
$uninstaller = Read-ScriptText "uninstall-coffee-upload-ingress.ps1"
$runtime = Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\production-runtime.mjs") -Raw
$combined = @($common, $installer, $uninstaller) -join "`n"

foreach ($required in @(
    "Artem Control Center Coffee Upload Ingress",
    "Assert-ArtemCoffeeUploadIngressPort",
    "LocalSubnet",
    "Profile Private",
    "ProgramPath",
    "LocalPort",
    "Remove-ArtemCoffeeUploadIngressFirewallRule"
)) {
    if ($combined -notlike "*$required*") {
        throw "Coffee upload ingress Windows contract is missing: $required"
    }
}

if ($installer -match "0\.0\.0\.0:8787" -or $runtime -match "--host[\s\S]{0,120}0\.0\.0\.0[\s\S]{0,120}8787") {
    throw "Coffee upload ingress contract must not bind the Panel Agent on 0.0.0.0:8787"
}
if ($installer -match "-LocalPort\s+8787") {
    throw "Coffee upload ingress firewall contract must reject the Panel Agent port"
}
if ($uninstaller -notmatch "Remove-ArtemCoffeeUploadIngressFirewallRule") {
    throw "Coffee upload ingress uninstall must remove only its named firewall rule"
}

Write-Host "Validated narrow Coffee upload ingress firewall and runtime contracts."
