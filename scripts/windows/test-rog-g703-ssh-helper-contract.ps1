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
if ($helper -match '\$args\b') {
    throw "ROG SSH helper must not read the implicit args automatic variable under StrictMode."
}
if ($helper -notmatch 'ValueFromRemainingArguments = \$true[\s\S]*?\[string\[\]\]\$RemainingArguments = @\(\)') {
    throw "ROG SSH helper must explicitly capture unexpected trailing values."
}
if ($helper -notmatch 'if \(\$RemainingArguments\.Count -ne 0\)\s*\{\s*exit 64') {
    throw "ROG SSH helper must reject unexpected trailing values with exit 64."
}
$startProcessBlock = [regex]::Match($helper, 'Start-Process[\s\S]*?-WindowStyle Hidden').Value
if (-not $startProcessBlock -or $startProcessBlock -match 'RemainingArguments') {
    throw "ROG SSH helper must never forward remaining arguments."
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

$trailingOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helperPath -Operation health UNEXPECTED_ARGUMENT_101A
$trailingExitCode = $LASTEXITCODE
if ($trailingExitCode -ne 64) {
    throw "ROG SSH helper must reject unexpected trailing arguments with exit 64."
}
if (($trailingOutput | Out-String).Trim()) {
    throw "ROG SSH helper must not emit a health response after trailing argument rejection."
}
# The child failure was expected and fully asserted above; do not propagate it
# through GitHub Actions' parent PowerShell harness.
$global:LASTEXITCODE = 0

if ($installer -notmatch 'ValidateSet\("install", "status", "uninstall"\)') {
    throw "ROG SSH helper installer must expose only install, status, and uninstall."
}
if ($installer -notmatch 'ArtemControlCenter\\RogG703Ssh' -or $installer -notmatch 'rog-g703-ssh-helper\.ps1') {
    throw "ROG SSH helper installer must use the fixed ProgramData destination."
}
foreach ($requiredAcl in @(
    '\*S-1-5-18:\(OI\)\(CI\)F',
    '\*S-1-5-32-544:\(OI\)\(CI\)F',
    '\*S-1-5-32-545:\(OI\)\(CI\)RX'
)) {
    if ($installer -notmatch $requiredAcl) {
        throw "ROG SSH helper installer must use the required well-known SID ACL."
    }
}
if ($installer -match '"SYSTEM:\(OI\)\(CI\)F"|"Administrators:\(OI\)\(CI\)F"|"Users:\(OI\)\(CI\)RX"') {
    throw "ROG SSH helper installer must not depend on localized account or group names."
}
if ($installer -notmatch 'icacls\.exe \$installRoot /inheritance:r[\s\S]*?\$LASTEXITCODE[\s\S]*?throw') {
    throw "ROG SSH helper installer must fail closed when inheritance removal fails."
}
if ($installer -notmatch 'icacls\.exe \$installRoot /grant:r[\s\S]*?\$LASTEXITCODE[\s\S]*?throw') {
    throw "ROG SSH helper installer must fail closed when SID ACL grant fails."
}
if ($installer -match 'New-NetFirewallRule|Set-Service|Start-Service|sshd|password|secret|credential') {
    throw "ROG SSH helper installer must not change SSH server, firewall, or credentials."
}

Write-Host "ROG G703 SSH helper contract tests passed."
