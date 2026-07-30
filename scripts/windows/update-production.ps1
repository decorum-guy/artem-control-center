param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Description
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

$paths = Get-ArtemRuntimePaths
Initialize-ArtemRuntimeDirectories -Paths $paths
Update-ArtemProcessPath

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$transcriptPath = Join-Path $paths.Logs "update-$timestamp.log"
Start-Transcript -Path $transcriptPath -Force | Out-Null

$currentHead = $null
$targetHead = $null
$updateApplied = $false

try {
    Set-Location -LiteralPath $paths.RepoRoot

    $branch = (& git.exe branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
        throw "Production checkout must be on main, current branch: $branch"
    }

    $dirty = & git.exe status --porcelain
    if ($LASTEXITCODE -ne 0) { throw "git status failed" }
    if ($dirty) { throw "Production checkout has local changes; update aborted" }

    Invoke-CheckedCommand `
        -FilePath "git.exe" `
        -Arguments @("fetch", "origin", "main") `
        -Description "git fetch"

    $currentHead = (& git.exe rev-parse HEAD).Trim()
    $targetHead = (& git.exe rev-parse origin/main).Trim()
    if (-not $currentHead -or -not $targetHead) {
        throw "Unable to resolve current or target revision"
    }

    if ($currentHead -eq $targetHead) {
        Write-Host "Artem Control Center is already up to date: $currentHead"
        if (-not (Test-ArtemRuntimeProcess -Paths $paths)) {
            Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue
            & $paths.StartScript
        }
        exit 0
    }

    Write-Host "Updating Artem Control Center"
    Write-Host "From: $currentHead"
    Write-Host "To:   $targetHead"

    Stop-ArtemRuntime -Paths $paths -Manual $false
    Set-Content -LiteralPath $paths.RollbackHead -Value $currentHead -Encoding ASCII

    Invoke-CheckedCommand `
        -FilePath "git.exe" `
        -Arguments @("merge", "--ff-only", "origin/main") `
        -Description "fast-forward update"
    $updateApplied = $true

    Invoke-CheckedCommand `
        -FilePath "npm.cmd" `
        -Arguments @("ci") `
        -Description "npm ci"
    Invoke-CheckedCommand `
        -FilePath "npm.cmd" `
        -Arguments @("run", "setup") `
        -Description "project setup"

    $env:PANEL_AGENT_MODE = "read_only"
    $env:PANEL_WRITES_ENABLED = "false"
    $env:PANEL_COFFEE_TIMING_WRITES_ENABLED = "false"
    $env:PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED = "false"
    $env:PANEL_COFFEE_ACTIONS_ENABLED = "false"
    $env:PANEL_KIOSK_CONTROLS_ENABLED = "false"

    Invoke-CheckedCommand `
        -FilePath "npm.cmd" `
        -Arguments @("run", "check") `
        -Description "full validation"

    Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue
    & $paths.StartScript
    if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 60)) {
        throw "Updated runtime failed the post-start health check"
    }

    Set-Content -LiteralPath $paths.LastKnownGood -Value $targetHead -Encoding ASCII
    Write-Host "Update successful: $targetHead"
}
catch {
    $failure = $_
    Write-Error "Update failed: $($failure.Exception.Message)"

    if ($currentHead) {
        try {
            Stop-ArtemRuntime -Paths $paths -Manual $false
            Set-Location -LiteralPath $paths.RepoRoot
            Invoke-CheckedCommand `
                -FilePath "git.exe" `
                -Arguments @("reset", "--hard", $currentHead) `
                -Description "git rollback"
            Invoke-CheckedCommand `
                -FilePath "npm.cmd" `
                -Arguments @("ci") `
                -Description "rollback npm ci"
            Invoke-CheckedCommand `
                -FilePath "npm.cmd" `
                -Arguments @("run", "setup") `
                -Description "rollback setup"
            Invoke-CheckedCommand `
                -FilePath "npm.cmd" `
                -Arguments @("run", "build") `
                -Description "rollback build"
            Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue
            & $paths.StartScript
            if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 60)) {
                throw "Rolled-back runtime did not become ready"
            }
            Set-Content -LiteralPath $paths.LastKnownGood -Value $currentHead -Encoding ASCII
            Write-Host "Rollback successful: $currentHead"
        }
        catch {
            Write-Error "Automatic rollback also failed: $($_.Exception.Message)"
        }
    }

    throw $failure
}
finally {
    Stop-Transcript | Out-Null
    Write-Host "Update log: $transcriptPath"
}
