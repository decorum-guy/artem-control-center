$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("artem-python-runtime-venv-{0}" -f [guid]::NewGuid())
$sourceRoot = Join-Path $testRoot "source"
$runtimeRoot = Join-Path $testRoot "ArtemControlCenter"
$revision = "e" * 40
$targetVenv = Join-Path $runtimeRoot ("venvs\{0}" -f $revision)
$previousRuntimeVenv = $env:PANEL_RUNTIME_VENV

try {
    New-Item -ItemType Directory -Force -Path @(
        (Join-Path $sourceRoot "scripts"),
        (Join-Path $sourceRoot "apps\panel-agent\tests"),
        (Join-Path $sourceRoot "node_modules")
    ) | Out-Null

    foreach ($file in @(
        "package.json",
        "scripts\setup.mjs",
        "scripts\runtime-venv.mjs",
        "scripts\python.mjs",
        "apps\panel-agent\requirements-dev.txt"
    )) {
        $destination = Join-Path $sourceRoot $file
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $destination
    }

    $pythonRegression = @'
import os
import sys


def normalized(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(str(path))))


def test_python_and_pytest_are_from_configured_environment():
    expected = normalized(os.environ["PANEL_RUNTIME_VENV"])
    assert normalized(sys.prefix) == expected
    assert os.path.normcase(os.path.abspath(sys.executable)).startswith(expected + os.sep)
    import pytest
    assert normalized(pytest.__file__).startswith(expected + os.sep)
'@
    Set-Content -LiteralPath (Join-Path $sourceRoot "apps\panel-agent\tests\test_configured_runtime_venv.py") -Value $pythonRegression -Encoding ASCII

    $env:PANEL_RUNTIME_VENV = $targetVenv
    Push-Location -LiteralPath $sourceRoot
    try {
        & npm.cmd run setup
        if ($LASTEXITCODE -ne 0) {
            throw "Detached runtime setup failed with exit code $LASTEXITCODE"
        }
        if (Test-Path -LiteralPath (Join-Path $sourceRoot ".venv")) {
            throw "Detached runtime setup unexpectedly created a checkout-local .venv"
        }

        & node.exe scripts\python.mjs -m pytest apps\panel-agent\tests\test_configured_runtime_venv.py -q
        if ($LASTEXITCODE -ne 0) {
            throw "Configured runtime Python launcher regression failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath (Join-Path $targetVenv "Scripts\python.exe"))) {
        throw "Configured runtime setup did not create its revision-scoped Python executable"
    }
}
finally {
    if ($null -eq $previousRuntimeVenv) {
        Remove-Item Env:PANEL_RUNTIME_VENV -ErrorAction SilentlyContinue
    }
    else {
        $env:PANEL_RUNTIME_VENV = $previousRuntimeVenv
    }
    $restoredRuntimeVenv = [Environment]::GetEnvironmentVariable("PANEL_RUNTIME_VENV", "Process")
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    if ($null -eq $previousRuntimeVenv) {
        if ($null -ne $restoredRuntimeVenv) {
            throw "PANEL_RUNTIME_VENV was not removed after the detached runtime regression"
        }
    }
    elseif ($restoredRuntimeVenv -cne $previousRuntimeVenv) {
        throw "PANEL_RUNTIME_VENV was not restored after the detached runtime regression"
    }
}

Write-Host "Validated detached-source setup and pytest execution through the configured revision-scoped runtime environment."
