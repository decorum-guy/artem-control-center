$ErrorActionPreference = "Stop"

$testRoot = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ("artem avalar identities {0}" -f [guid]::NewGuid())
$previousUserProfile = $env:USERPROFILE
$previousLocalAppData = $env:LOCALAPPDATA

try {
    $env:USERPROFILE = Join-Path $testRoot "Panel User"
    $env:LOCALAPPDATA = Join-Path $testRoot "Local App Data"
    New-Item -ItemType Directory -Force -Path $env:USERPROFILE | Out-Null
    New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA | Out-Null

    $installer = Join-Path $PSScriptRoot "install-avalar-identities.ps1"
    & $installer `
        -HostName "example.com" `
        -UserName "test-user" `
        -StatusAlias "avalar-status-test" `
        -ActionAlias "avalar-control-test"

    $sshRoot = Join-Path $env:USERPROFILE ".ssh"
    $statusPrivate = Join-Path $sshRoot "artem_control_center_avalar_status"
    $statusPublic = "$statusPrivate.pub"
    $actionPrivate = Join-Path $sshRoot "artem_control_center_avalar_actions"
    $actionPublic = "$actionPrivate.pub"
    $configPath = Join-Path $sshRoot "config"
    $runtimeRoot = Join-Path $env:LOCALAPPDATA "ArtemControlCenter"

    foreach ($required in @(
        $statusPrivate,
        $statusPublic,
        $actionPrivate,
        $actionPublic,
        $configPath,
        (Join-Path $runtimeRoot "avalar-status-public-key.txt"),
        (Join-Path $runtimeRoot "avalar-action-public-key.txt")
    )) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "AVALAR identity installer did not create: $required"
        }
    }

    foreach ($publicKey in @($statusPublic, $actionPublic)) {
        $line = (Get-Content -LiteralPath $publicKey -Raw).Trim()
        if ($line -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/=]+\s+artem-control-center-avalar-') {
            throw "Generated AVALAR public key has an unexpected format: $publicKey"
        }
    }

    $config = Get-Content -LiteralPath $configPath -Raw
    foreach ($expected in @(
        "Host avalar-status-test",
        "Host avalar-control-test",
        "HostName example.com",
        "User test-user",
        "BatchMode yes",
        "RequestTTY no"
    )) {
        if ($config -notmatch [regex]::Escape($expected)) {
            throw "Generated SSH config is missing: $expected"
        }
    }

    $statusHash = (Get-FileHash -LiteralPath $statusPrivate -Algorithm SHA256).Hash
    $actionHash = (Get-FileHash -LiteralPath $actionPrivate -Algorithm SHA256).Hash

    & $installer `
        -HostName "example.com" `
        -UserName "test-user" `
        -StatusAlias "avalar-status-test" `
        -ActionAlias "avalar-control-test"

    if ((Get-FileHash -LiteralPath $statusPrivate -Algorithm SHA256).Hash -ne $statusHash) {
        throw "Status identity was unexpectedly regenerated"
    }
    if ((Get-FileHash -LiteralPath $actionPrivate -Algorithm SHA256).Hash -ne $actionHash) {
        throw "Action identity was unexpectedly regenerated"
    }

    $config = Get-Content -LiteralPath $configPath -Raw
    if (([regex]::Matches($config, '# BEGIN ARTEM CONTROL CENTER AVALAR IDENTITIES')).Count -ne 1) {
        throw "AVALAR SSH config block is not idempotent"
    }
}
finally {
    $env:USERPROFILE = $previousUserProfile
    $env:LOCALAPPDATA = $previousLocalAppData
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated AVALAR identity generation with an empty passphrase, spaced paths and idempotent reruns."
