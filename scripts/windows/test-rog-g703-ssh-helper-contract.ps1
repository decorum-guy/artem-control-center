$ErrorActionPreference = "Stop"

$helperPath = Join-Path $PSScriptRoot "rog-g703-ssh-helper.ps1"
$installerPath = Join-Path $PSScriptRoot "install-rog-g703-ssh-helper.ps1"
$helper = Get-Content -LiteralPath $helperPath -Raw
$installer = Get-Content -LiteralPath $installerPath -Raw

if ($helper -notmatch 'ValidateSet\("health", "sleep", "hibernate"\)') {
    throw "ROG SSH helper must allow only health, sleep, and hibernate."
}
if ($helper -match 'Invoke-Expression|\[scriptblock\]|\[string\]\$Command|\[string\]\$Script') {
    throw "ROG SSH helper must not expose a generic command or scriptblock surface."
}
if ($helper -notmatch 'SetSuspendState\(\$false, \$true, \$false\)') {
    throw "ROG SSH Sleep must use explicit Windows suspend rather than hibernation."
}
if ($helper -notmatch 'shutdown\.exe" /h') {
    throw "ROG SSH Hibernate must invoke the fixed real Windows hibernate operation."
}
if ($helper -notmatch 'Start-FixedDetachedTransition[\s\S]*?Write-StrictJson') {
    throw "ROG SSH helper must schedule the fixed delayed transition before acknowledgement."
}
if ($helper -notmatch '\[Console\]::Out\.Flush\(\)') {
    throw "ROG SSH helper must flush its strict acknowledgement JSON."
}

$healthOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helperPath -Operation health
if ($LASTEXITCODE -ne 0) {
    throw "ROG SSH helper health must be safe and successful in Windows CI."
}
$health = ($healthOutput | Out-String | ConvertFrom-Json)
if ($health.schemaVersion -ne 1 -or -not $health.ok -or $health.status -ne "online") {
    throw "ROG SSH helper health JSON contract is invalid."
}

if ($installer -notmatch 'ValidateSet\("install", "status", "uninstall"\)') {
    throw "ROG SSH helper installer must expose only install, status, and uninstall."
}
if ($installer -notmatch 'ArtemControlCenter\\RogG703Ssh' -or $installer -notmatch 'rog-g703-ssh-helper\.ps1') {
    throw "ROG SSH helper installer must use the fixed ProgramData destination."
}
if ($installer -notmatch 'Users:\(OI\)\(CI\)RX' -or $installer -notmatch 'Administrators:\(OI\)\(CI\)F') {
    throw "ROG SSH helper installer must preserve read/execute while protecting modification."
}
if ($installer -match 'New-NetFirewallRule|Set-Service|Start-Service|sshd|password|secret|credential') {
    throw "ROG SSH helper installer must not change SSH server, firewall, or credentials."
}

Write-Host "ROG G703 SSH helper contract tests passed."
