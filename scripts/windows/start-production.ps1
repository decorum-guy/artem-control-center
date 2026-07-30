param(
    [switch]$AutoStart,
    [switch]$NoKiosk,
    [switch]$Wait
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
Initialize-ArtemRuntimeDirectories -Paths $paths
Update-ArtemProcessPath

if ($AutoStart -and (Test-Path -LiteralPath $paths.ManualStop)) {
    Write-Host "Artem Control Center remains stopped by manual request."
    exit 0
}

if (-not $AutoStart) {
    Remove-Item -LiteralPath $paths.ManualStop -Force -ErrorAction SilentlyContinue
}

Assert-ArtemProductionPrerequisites -Paths $paths

if (Test-ArtemRuntimeProcess -Paths $paths) {
    if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 20)) {
        throw "Production runtime process exists but is not ready"
    }
    if (-not $NoKiosk) {
        & $paths.OpenKioskScript -AssumeRuntimeReady
    }
    Write-Host "Artem Control Center is already running."
    exit 0
}

Remove-Item -LiteralPath $paths.State -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $paths.Command -Force -ErrorAction SilentlyContinue

$node = (Get-Command node.exe -ErrorAction Stop).Source
$argumentLine = "`"$($paths.RuntimeScript)`""
$runtimeProcess = Start-Process `
    -FilePath $node `
    -ArgumentList $argumentLine `
    -WorkingDirectory $paths.RepoRoot `
    -WindowStyle Hidden `
    -PassThru

if (-not (Wait-ArtemPanelReady -Paths $paths -TimeoutSeconds 60)) {
    if (-not $runtimeProcess.HasExited) {
        & taskkill.exe /PID $runtimeProcess.Id /T /F | Out-Null
    }
    throw "Production runtime did not become ready within 60 seconds"
}

if (-not $NoKiosk) {
    & $paths.OpenKioskScript -AssumeRuntimeReady
}

Write-Host "Artem Control Center production runtime started."
Write-Host "PID: $($runtimeProcess.Id)"
Write-Host "URL: $($paths.PanelUrl)"

if ($AutoStart -or $Wait) {
    $runtimeProcess.WaitForExit()
    exit $runtimeProcess.ExitCode
}
