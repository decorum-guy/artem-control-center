$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$updaterPath = Join-Path $PSScriptRoot "update-production.ps1"
$updaterText = Get-Content -LiteralPath $updaterPath -Raw

if (-not $updaterText.Contains('$pytestTempForPytest')) {
    throw "Updater must normalize the pytest basetemp before placing it in PYTEST_ADDOPTS"
}
if (-not $updaterText.Contains('--basetemp=`"$pytestTempForPytest`"')) {
    throw "Updater must quote the normalized pytest basetemp in PYTEST_ADDOPTS"
}
if ($updaterText.Contains('--basetemp=$pytestTemp -p no:cacheprovider')) {
    throw "Updater must not place a raw Windows path in PYTEST_ADDOPTS"
}
if (-not $updaterText.Contains('Production checkout has local changes; update aborted')) {
    throw "Updater dirty-worktree guard must remain enabled"
}
if (-not $updaterText.Contains('Remove-Item -LiteralPath $validationRoot -Recurse -Force -ErrorAction SilentlyContinue')) {
    throw "Updater must clean the isolated validation root in finally"
}
if ($updaterText -match '(?im)\bgit(?:\.exe)?\s+clean\b') {
    throw "Updater regression must not be fixed with git clean"
}

$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "Project virtualenv is required; run npm run setup before this regression"
}

$regressionRoot = Join-Path `
    ([IO.Path]::GetTempPath()) `
    ("artem updater validation regression {0}" -f [guid]::NewGuid())
$worktree = Join-Path $regressionRoot "repo"
$validationRoot = Join-Path $regressionRoot "Artem Control Center\validation-temp\fixture"
$pytestTemp = Join-Path $validationRoot "pytest base"
$testFile = Join-Path $regressionRoot "test_updater_validation_temp.py"

$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$previousPytestAddopts = $env:PYTEST_ADDOPTS
$locationPushed = $false

try {
    New-Item -ItemType Directory -Force -Path $worktree | Out-Null
    New-Item -ItemType Directory -Force -Path $pytestTemp | Out-Null
    @(
        "def test_tmp_path_is_available(tmp_path):",
        "    assert tmp_path.exists()"
    ) | Set-Content -LiteralPath $testFile -Encoding ASCII

    Push-Location -LiteralPath $worktree
    $locationPushed = $true

    & git.exe init --quiet
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to initialize isolated regression repository"
    }

    $before = @(& git.exe status --porcelain)
    if ($LASTEXITCODE -ne 0) {
        throw "Initial git status failed"
    }
    if ($before.Count -ne 0) {
        throw "Isolated regression repository must start clean"
    }

    $env:TEMP = $validationRoot
    $env:TMP = $validationRoot
    $pytestTempForPytest = $pytestTemp.Replace('\', '/')
    $env:PYTEST_ADDOPTS = "--basetemp=`"$pytestTempForPytest`" -p no:cacheprovider"

    & $venvPython -m pytest $testFile -q
    if ($LASTEXITCODE -ne 0) {
        throw "Pytest validation-temp regression failed"
    }

    if (-not (Test-Path -LiteralPath $pytestTemp)) {
        throw "Pytest did not use the intended absolute basetemp outside the repository"
    }

    $after = @(& git.exe status --porcelain)
    if ($LASTEXITCODE -ne 0) {
        throw "Final git status failed"
    }
    if ($after.Count -ne 0) {
        throw ("Pytest validation leaked files into the repository: {0}" -f ($after -join "; "))
    }

    $unexpected = @(
        Get-ChildItem -LiteralPath $worktree -Force |
            Where-Object { $_.Name -ne ".git" }
    )
    if ($unexpected.Count -ne 0) {
        throw ("Unexpected repo-local validation artifacts remain: {0}" -f (($unexpected | ForEach-Object Name) -join ", "))
    }
}
finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    $env:PYTEST_ADDOPTS = $previousPytestAddopts
    if ($locationPushed) {
        Pop-Location
    }
    Remove-Item -LiteralPath $regressionRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated Windows-safe pytest basetemp parsing, repo cleanliness, cleanup contract and dirty-worktree guard."
