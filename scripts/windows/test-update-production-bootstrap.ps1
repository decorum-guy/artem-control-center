$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$root = Join-Path ([IO.Path]::GetTempPath()) ("artem-update-bootstrap-{0}" -f [guid]::NewGuid())
$repo = Join-Path $root "repo"
$scriptPath = Join-Path $repo "scripts\windows\update-production.ps1"

try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $scriptPath) | Out-Null
    & git.exe init --quiet $repo
    if ($LASTEXITCODE -ne 0) { throw "Unable to initialize bootstrap fixture repository" }
    & git.exe -C $repo config user.email "bootstrap-fixture@example.invalid"
    & git.exe -C $repo config user.name "bootstrap-fixture"

    function New-FixtureUpdater {
        param([Parameter(Mandatory)][ValidateSet("A", "B")][string]$Label)
        return @"
param(
    [switch]`$Continuation,
    [string]`$TargetHead,
    [string]`$Marker
)
`$ErrorActionPreference = "Stop"
`$repoRoot = (Resolve-Path (Join-Path `$PSScriptRoot "..\.." )).Path
if (`$Continuation) {
    `$head = (& git.exe -C `$repoRoot rev-parse HEAD).Trim().ToLowerInvariant()
    if (`$LASTEXITCODE -ne 0 -or `$head -ne `$TargetHead.ToLowerInvariant()) { exit 2 }
    Set-Content -LiteralPath `$Marker -Value "$Label" -Encoding ASCII
    exit 0
}
& git.exe -C `$repoRoot merge --ff-only `$TargetHead | Out-Null
if (`$LASTEXITCODE -ne 0) { exit 3 }
`$child = Start-Process powershell.exe -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", `$PSCommandPath, "-Continuation", "-TargetHead", `$TargetHead, "-Marker", `$Marker
) -Wait -PassThru
exit `$child.ExitCode
"@
    }

    $markerPath = Join-Path $root "target-phase.txt"
    Set-Content -LiteralPath $scriptPath -Value (New-FixtureUpdater -Label "A") -Encoding ASCII
    & git.exe -C $repo add scripts/windows/update-production.ps1
    & git.exe -C $repo commit --quiet -m "updater A"
    $baseHead = (& git.exe -C $repo rev-parse HEAD).Trim().ToLowerInvariant()

    Set-Content -LiteralPath $scriptPath -Value (New-FixtureUpdater -Label "B") -Encoding ASCII
    & git.exe -C $repo add scripts/windows/update-production.ps1
    & git.exe -C $repo commit --quiet -m "updater B"
    $targetHead = (& git.exe -C $repo rev-parse HEAD).Trim().ToLowerInvariant()

    $paths = [pscustomobject]@{
        RepoRoot = $repo
        UpdateScript = $scriptPath
    }

    $callerLocation = (Get-Location).Path
    Assert-ArtemTargetUpdaterLogic -Paths $paths -ExpectedTargetHead $targetHead
    if ((Get-Location).Path -ne $callerLocation) {
        throw "Target updater logic assertion must preserve the caller location"
    }
    Set-Content -LiteralPath $scriptPath -Value "Write-Output 'updater-A'" -Encoding ASCII
    $rejectedStaleLogic = $false
    try {
        Assert-ArtemTargetUpdaterLogic -Paths $paths -ExpectedTargetHead $targetHead
    }
    catch {
        $rejectedStaleLogic = $_.Exception.Message -like "*does not match*"
    }
    if (-not $rejectedStaleLogic) {
        throw "Target continuation accepted updater A after checkout target B"
    }

    & git.exe -C $repo reset --hard --quiet $baseHead
    $launch = Start-Process powershell.exe -ArgumentList @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $scriptPath, "-TargetHead", $targetHead, "-Marker", $markerPath
    ) -Wait -PassThru
    if ($launch.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $markerPath)) {
        throw "Fixture updater A did not complete its target handoff"
    }
    if ((Get-Content -LiteralPath $markerPath -Raw).Trim() -ne "B") {
        throw "Target-dependent fixture phase did not execute updater B"
    }
    $finalHead = (& git.exe -C $repo rev-parse HEAD).Trim().ToLowerInvariant()
    if ($finalHead -ne $targetHead) {
        throw "Fixture updater did not advance the checkout to target B"
    }

    $updaterText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "update-production.ps1") -Raw
    $handoffText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "updater-target-handoff.ps1") -Raw
    if ($updaterText -notmatch 'Invoke-ArtemTargetUpdater' -or $handoffText -notmatch 'Start-Process[\s\S]*-Continuation') {
        throw "Canonical updater is missing the explicit target continuation handoff"
    }
    if ($baseHead -eq $targetHead) { throw "Bootstrap fixture did not create two revisions" }
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated target updater A/B blob proof, executed A-to-B continuation, and explicit target continuation handoff."
