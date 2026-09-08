$ErrorActionPreference = "Stop"

$updaterPath = Join-Path $PSScriptRoot "update-production.ps1"
$updaterText = Get-Content -LiteralPath $updaterPath -Raw

# Production staging deliberately no longer turns the serving Samsung into a
# second CI runner. Keep this executable Windows contract close to the former
# validation-temp regression so a future edit cannot quietly restore pytest or
# an ordinary dashboard build to the updater path.
foreach ($forbidden in @(
    "PYTEST_ADDOPTS",
    "validation-temp",
    "check-dist",
    "PANEL_DASHBOARD_BUILD_OUT_DIR",
    'Arguments @("run", "check")',
    'Arguments @("run", "lint")',
    'Arguments @("run", "typecheck")',
    'Arguments @("run", "test")'
)) {
    if ($updaterText.Contains($forbidden)) {
        throw "Production staging must not restore full local validation: $forbidden"
    }
}
if (-not $updaterText.Contains('Arguments @("run", "production-update-preflight")')) {
    throw "Production staging must invoke the fixed narrow host preflight"
}
if (($updaterText.Split('Arguments @("run", "build:production")').Count - 1) -ne 1) {
    throw "Production staging must perform exactly one accepted-v2 production build"
}
if (-not $updaterText.Contains('git.exe status --porcelain --untracked-files=no')) {
    throw "Updater must reject tracked checkout changes without treating untracked staging files as source changes"
}
if (-not $updaterText.Contains('Production checkout has tracked local changes')) {
    throw "Updater tracked dirty-worktree guard must remain enabled"
}
if ($updaterText -match '(?im)\bgit(?:\.exe)?\s+clean\b') {
    throw "Updater regression must not be fixed with git clean"
}

& (Join-Path $PSScriptRoot "test-update-maintenance-lease.ps1")

Write-Host "Validated narrow Windows production staging, one accepted-v2 build, retained dirty-worktree guard, and update maintenance lease recovery."
