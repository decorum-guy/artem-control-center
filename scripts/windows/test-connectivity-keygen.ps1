$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "ssh-keygen-common.ps1")

$testRoot = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ("artem connectivity keygen {0}" -f [guid]::NewGuid())

try {
    $sshRoot = Join-Path $testRoot "Panel User\.ssh"
    New-Item -ItemType Directory -Force -Path $sshRoot | Out-Null
    $keyPath = Join-Path $sshRoot "artem_control_center_tunnel"
    $sshKeygen = (Get-Command ssh-keygen.exe -ErrorAction Stop).Source

    $created = Ensure-ArtemEd25519Identity `
        -Executable $sshKeygen `
        -KeyPath $keyPath `
        -Comment "artem-control-center-tunnel@WINDOWS-CI"
    if (-not $created.Created) {
        throw "First connectivity identity invocation did not report creation"
    }
    foreach ($required in @($keyPath, "$keyPath.pub")) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "Connectivity identity helper did not create: $required"
        }
    }

    $publicLine = (Get-Content -LiteralPath "$keyPath.pub" -Raw).Trim()
    if ($publicLine -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/=]+\s+artem-control-center-tunnel@WINDOWS-CI$') {
        throw "Generated connectivity public key has an unexpected format"
    }

    # A key without a passphrase must be readable non-interactively.
    $derivedPublic = & $sshKeygen -y -f $keyPath 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $derivedPublic) {
        throw "Generated connectivity private key is not usable without an interactive passphrase"
    }

    $privateHash = (Get-FileHash -LiteralPath $keyPath -Algorithm SHA256).Hash
    $reused = Ensure-ArtemEd25519Identity `
        -Executable $sshKeygen `
        -KeyPath $keyPath `
        -Comment "artem-control-center-tunnel@WINDOWS-CI"
    if ($reused.Created) {
        throw "Connectivity identity was unexpectedly regenerated"
    }
    if ((Get-FileHash -LiteralPath $keyPath -Algorithm SHA256).Hash -ne $privateHash) {
        throw "Connectivity private key changed during an idempotent rerun"
    }
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated connectivity ED25519 generation with an empty passphrase, spaced paths and idempotent reuse."
