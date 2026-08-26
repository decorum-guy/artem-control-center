$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("artem-update-lease-{0}" -f [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$lockPath = Join-Path $testRoot "update-lock.json"
$paths = [pscustomobject]@{ UpdateLock = $lockPath }
$requestId = "0123456789abcdef01234567"
$current = "a" * 40
$target = "b" * 40
$owner = $null

function Write-TestUpdateLock {
    param(
        [Parameter(Mandatory)][DateTimeOffset]$UpdatedAt,
        [int]$OwnerPid = 0,
        [switch]$IncludeOwner
    )
    $payload = @{
        schemaVersion = 1
        status = "updating"
        requestId = $requestId
        expectedCurrentHead = $current
        expectedTargetHead = $target
        updatedAt = $UpdatedAt.ToUniversalTime().ToString("o")
    }
    if ($IncludeOwner) { $payload.ownerPid = $OwnerPid }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $lockPath -Encoding ASCII
}

try {
    Write-TestUpdateLock -UpdatedAt ([DateTimeOffset]::UtcNow.AddMinutes(-1))
    if ($null -eq (Get-ArtemSoftwareUpdateLock -Paths $paths)) {
        throw "Recent pre-owner update handoff must remain active"
    }

    Write-TestUpdateLock -UpdatedAt ([DateTimeOffset]::UtcNow.AddMinutes(-3))
    if ($null -ne (Get-ArtemSoftwareUpdateLock -Paths $paths)) {
        throw "Abandoned pre-owner update handoff must expire after the short lease"
    }
    if (Test-Path -LiteralPath $lockPath) {
        throw "Expired pre-owner update handoff must be cleaned up"
    }

    Write-TestUpdateLock -UpdatedAt ([DateTimeOffset]::UtcNow.AddDays(1))
    if ($null -ne (Get-ArtemSoftwareUpdateLock -Paths $paths)) {
        throw "Future update timestamp must never become an immortal maintenance lease"
    }

    $ownerScript = Join-Path $testRoot "update-production.ps1"
    @(
        'param([string]$RequestId)',
        'Start-Sleep -Seconds 30'
    ) | Set-Content -LiteralPath $ownerScript -Encoding ASCII
    $owner = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile",
            "-NonInteractive",
            "-File", "`"$ownerScript`"",
            "-RequestId", $requestId
        ) `
        -WindowStyle Hidden `
        -PassThru
    Start-Sleep -Milliseconds 600

    Write-TestUpdateLock `
        -UpdatedAt ([DateTimeOffset]::UtcNow.AddHours(-4)) `
        -OwnerPid $owner.Id `
        -IncludeOwner
    $live = Get-ArtemSoftwareUpdateLock -Paths $paths
    if ($null -eq $live -or [int]$live.ownerPid -ne $owner.Id) {
        throw "Verified live updater PID must remain authoritative beyond timestamp age"
    }

    Stop-Process -Id $owner.Id -Force -ErrorAction Stop
    $owner.WaitForExit()
    $owner = $null
    if ($null -ne (Get-ArtemSoftwareUpdateLock -Paths $paths)) {
        throw "Dead updater PID must make the update lease recoverable immediately"
    }
    if (Test-Path -LiteralPath $lockPath) {
        throw "Dead updater lease must be cleaned up"
    }

    $startText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "start-production.ps1") -Raw
    if ($startText -notmatch '\$null\s+-ne\s+\$activeUpdate\s+-and\s+-not\s+\$ownsUpdate') {
        throw "Open must continue to block a competing start while a live update lease exists"
    }

    $updaterText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "update-production.ps1") -Raw
    foreach ($required in @('ownerPid = $PID', 'Claim-ArtemUpdateLock', 'Refresh-ArtemUpdateLock')) {
        if (-not $updaterText.Contains($required)) {
            throw "Updater lease ownership contract missing: $required"
        }
    }

    $stateIndex = $updaterText.IndexOf('$transcriptStarted = $false')
    $tryIndex = $updaterText.IndexOf('try {', $stateIndex)
    $claimIndex = $updaterText.IndexOf('Claim-ArtemUpdateLock', $tryIndex)
    $startTranscriptIndex = $updaterText.IndexOf('Start-Transcript', $tryIndex)
    $finallyIndex = $updaterText.IndexOf('finally {', $startTranscriptIndex)
    $removeIndex = $updaterText.IndexOf('Remove-ArtemUpdateLock', $finallyIndex)
    $guardIndex = $updaterText.IndexOf('if ($transcriptStarted)', $finallyIndex)
    $stopTranscriptIndex = $updaterText.IndexOf('Stop-Transcript', $guardIndex)
    if (
        $stateIndex -lt 0 -or
        $tryIndex -lt $stateIndex -or
        $claimIndex -lt $tryIndex -or
        $startTranscriptIndex -lt $claimIndex -or
        $finallyIndex -lt $startTranscriptIndex -or
        $removeIndex -lt $finallyIndex -or
        $guardIndex -lt $removeIndex -or
        $stopTranscriptIndex -lt $guardIndex
    ) {
        throw "Transcript startup must be inside the lock-removing transaction and Stop-Transcript must be guarded"
    }
}
finally {
    if ($null -ne $owner -and -not $owner.HasExited) {
        Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated live/dead updater ownership, bounded handoff/future timestamps, Open exclusion and transcript-failure lock cleanup ordering."
