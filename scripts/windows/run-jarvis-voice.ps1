$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

$paths = Get-ArtemRuntimePaths
$voice = Get-ArtemJarvisVoicePaths -Paths $paths
$python = Join-Path $voice.Venv "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Jarvis voice venv is not provisioned."
}

$voiceSource = Join-Path $paths.RepoRoot "apps\jarvis-voice\src"
$panelAgentSource = Join-Path $paths.RepoRoot "apps\panel-agent\src"
foreach ($sourceRoot in @($voiceSource, $panelAgentSource)) {
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        throw "Jarvis voice source layout is incomplete."
    }
}

$null = Set-ArtemJarvisVoiceWorkerEnvironment -Paths $paths
# Do not inherit unrelated source roots. The worker receives only its own and
# Panel Agent's source packages, plus the explicit Jarvis runtime allow-list.
$env:PYTHONPATH = $voiceSource + [IO.Path]::PathSeparator + $panelAgentSource
& $python -m $voice.WorkerModule
exit $LASTEXITCODE
