$ErrorActionPreference = "Stop"

$installerPath = Join-Path $PSScriptRoot "install-avalar-identities.ps1"
$configurePath = Join-Path $PSScriptRoot "configure-avalar-integration.ps1"
$installer = Get-Content -LiteralPath $installerPath -Raw
$configurator = Get-Content -LiteralPath $configurePath -Raw

foreach ($required in @(
    "artem_control_center_avalar_status",
    "artem_control_center_avalar_actions",
    "Host `$StatusAlias",
    "Host `$ActionAlias",
    "IdentityFile `$statusKeyForConfig",
    "IdentityFile `$actionKeyForConfig",
    "IdentitiesOnly yes",
    "BatchMode yes",
    "RequestTTY no",
    "StrictHostKeyChecking accept-new",
    "avalar-status-public-key.txt",
    "avalar-action-public-key.txt"
)) {
    if ($installer -notlike "*$required*") {
        throw "AVALAR identity installer contract is missing: $required"
    }
}

if ($installer -match 'Copy-Item[^\r\n]*(artem_control_center_avalar_status|artem_control_center_avalar_actions)[^\r\n]*RuntimeRoot') {
    throw "AVALAR private keys must never be copied into the runtime exchange directory"
}
if ($installer -match 'Write-Host[^\r\n]*(statusKey|actionKey)(?!ForConfig)') {
    throw "AVALAR identity installer must not print private key paths"
}
if ($installer -match '\$env:USERDOMAIN') {
    throw "AVALAR identity ACLs must use the resolved current user SID"
}

foreach ($required in @(
    'PANEL_AVALAR_SSH_HOST = $StatusSshHost',
    'PANEL_AVALAR_ACTION_SSH_HOST = $ActionSshHost',
    'PANEL_AVALAR_SSH_STATUS_COMMAND = "control-center"',
    'PANEL_AVALAR_ACTION_COMMAND = "control-center"'
)) {
    if ($configurator -notlike "*$required*") {
        throw "AVALAR runtime configurator contract is missing: $required"
    }
}
if ($configurator -match 'IdentityFile|PRIVATE KEY|\.ssh\\artem_control_center_avalar') {
    throw "AVALAR runtime configuration must reference aliases, never private identity paths"
}

Write-Host "Validated separate AVALAR keys, aliases, public-key exchange and alias-only runtime configuration."
