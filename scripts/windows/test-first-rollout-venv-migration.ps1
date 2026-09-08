$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("artem-first-rollout-venv-{0}" -f [guid]::NewGuid())
$targetSource = Join-Path $testRoot "target-source"
$runtimeRoot = Join-Path $testRoot "ArtemControlCenter"
$previousRuntimeVenv = $env:PANEL_RUNTIME_VENV
$worktreeAdded = $false

function Assert-ArtemFirstRollout {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw $Message }
}

try {
    # FIRST-ROLLOUT REGRESSION: emulate the updater already installed on a
    # machine before this target existed. It stages this exact target worktree,
    # supplies its revision venv only to target setup, then restores/removes it
    # before target check and production build. No runtime/cutover script runs.
    $targetHead = (& git.exe -C $repoRoot rev-parse HEAD).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $targetHead -notmatch '^[0-9a-f]{40}$') {
        throw "Unable to resolve the target revision for first-rollout regression"
    }
    & git.exe -C $repoRoot worktree add --detach $targetSource $targetHead
    if ($LASTEXITCODE -ne 0) { throw "Unable to create exact target staging worktree" }
    $worktreeAdded = $true

    Push-Location -LiteralPath $targetSource
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw "Target staging npm ci failed" }

        $targetVenv = Join-Path $runtimeRoot ("venvs\{0}" -f $targetHead)
        $env:PANEL_RUNTIME_VENV = $targetVenv
        & npm.cmd run setup
        if ($LASTEXITCODE -ne 0) { throw "Target setup with explicit revision venv failed" }
    }
    finally {
        Pop-Location
        # This is the historical baseline behavior that caused #200: the old
        # updater restores its process environment before target validation.
        if ($null -eq $previousRuntimeVenv) {
            Remove-Item Env:PANEL_RUNTIME_VENV -ErrorAction SilentlyContinue
        }
        else {
            $env:PANEL_RUNTIME_VENV = $previousRuntimeVenv
        }
    }

    $markerPath = Join-Path $targetSource "node_modules\.cache\artem-control-center\revision-runtime-venv.json"
    Assert-ArtemFirstRollout -Condition (Test-Path -LiteralPath $markerPath -PathType Leaf) -Message "Target setup did not leave the bounded staging venv marker"
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    Assert-ArtemFirstRollout -Condition (
        $marker.schemaVersion -eq "panel-staged-runtime-venv.v1" -and
        $marker.revision -eq $targetHead -and
        $marker.venvRoot -eq $targetVenv
    ) -Message "Target staging marker did not bind the exact target revision environment"
    Assert-ArtemFirstRollout -Condition (-not (Test-Path -LiteralPath (Join-Path $targetSource ".venv"))) -Message "First-rollout staging created a checkout-local developer venv"

    Push-Location -LiteralPath $targetSource
    try {
        $resolvedVenv = (& node.exe -e "import('./scripts/runtime-venv.mjs').then(({readStagedRuntimeVenvRoot}) => console.log(readStagedRuntimeVenvRoot(process.cwd()) || ''))").Trim()
        Assert-ArtemFirstRollout -Condition ($resolvedVenv -eq $targetVenv) -Message "Target validation could not rediscover the setup revision venv after environment restoration"

        $checkOutput = @(& npm.cmd run check 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "First-rollout target check failed after old updater environment restoration" }
        $checkText = $checkOutput -join "`n"
        Assert-ArtemFirstRollout -Condition ($checkText -match "Production update preflight passed") -Message "Old updater target check did not use the proven narrow preflight"
        foreach ($unexpected in @("npm run test", "npm run lint", "npm run typecheck", "pytest", "npm run build")) {
            Assert-ArtemFirstRollout -Condition (-not $checkText.Contains($unexpected)) -Message "Old updater target check repeated full validation: $unexpected"
        }
        & npm.cmd run build:production
        if ($LASTEXITCODE -ne 0) { throw "First-rollout target production build failed after old updater environment restoration" }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $previousRuntimeVenv) {
        Remove-Item Env:PANEL_RUNTIME_VENV -ErrorAction SilentlyContinue
    }
    else {
        $env:PANEL_RUNTIME_VENV = $previousRuntimeVenv
    }
    if ($worktreeAdded) {
        & git.exe -C $repoRoot worktree remove --force $targetSource | Out-Null
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated OLD-UPDATER setup env restoration to NEW-TARGET check/build through the exact revision staging marker."
