$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-common.ps1")

function Assert-JarvisVoice {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function New-TestVoiceWorker {
    param([object]$SessionId)
    return [pscustomobject]@{ SessionId = $SessionId }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("artem-jarvis-voice-{0}" -f [guid]::NewGuid())
try {
    $runtime = Join-Path $root "runtime"
    $models = Join-Path $root "models"
    $wake = Join-Path $models "wake.onnx"
    $stt = Join-Path $models "stt"
    New-Item -ItemType Directory -Force -Path $stt | Out-Null
    Set-Content -LiteralPath $wake -Value "fixture" -Encoding ASCII
    $runtimeEnv = Join-Path $runtime "runtime.env"
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    $runtimeEnvContents = @'
# literal values: never execute this file
PANEL_JARVIS_VOICE_ENABLED=true
PANEL_JARVIS_VOICE_BRIDGE_TOKEN=bridge=token$literal
PANEL_JARVIS_VOICE_PANEL_URL=http://127.0.0.1:8787
PANEL_JARVIS_VOICE_MODEL_ROOT=__VOICE_MODEL_ROOT_VALUE__
PANEL_JARVIS_WAKE_MODEL=__WAKE_MODEL_VALUE__
PANEL_JARVIS_STT_MODEL=__STT_MODEL_VALUE__
PANEL_JARVIS_STT_PROFILE=base
PANEL_JARVIS_WAKE_THRESHOLD=0.5
PANEL_JARVIS_MIC_DEVICE=
PANEL_UNRELATED_SHOULD_NOT_PROPAGATE=never
'@
    $runtimeEnvContents.Replace("__VOICE_MODEL_ROOT_VALUE__", $models).Replace("__WAKE_MODEL_VALUE__", $wake).Replace("__STT_MODEL_VALUE__", $stt) |
        Set-Content -LiteralPath $runtimeEnv -Encoding UTF8
    $paths = [pscustomobject]@{ RuntimeEnv = $runtimeEnv }

    $allowed = Get-ArtemJarvisVoiceRuntimeEnvironment -Paths $paths
    Assert-JarvisVoice ($allowed.Count -eq 9) "Only the nine explicit Jarvis voice keys may propagate"
    Assert-JarvisVoice ($allowed["PANEL_JARVIS_VOICE_BRIDGE_TOKEN"] -ceq "bridge=token`$literal") "Token must remain a literal value after the first equals sign"
    Assert-JarvisVoice (-not $allowed.Contains("PANEL_UNRELATED_SHOULD_NOT_PROPAGATE")) "Unrelated PANEL variables must not propagate"
    $configuration = Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $allowed
    Assert-JarvisVoice ($configuration.Enabled -and $configuration.Configured -and $configuration.ModelsReady) "Complete valid local configuration must be ready"

    $disabled = [ordered]@{}
    foreach ($key in $allowed.Keys) { $disabled[$key] = $allowed[$key] }
    $disabled["PANEL_JARVIS_VOICE_ENABLED"] = "false"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $disabled).Enabled) "Disabled configuration must not start audio"
    $missingModels = [ordered]@{}
    foreach ($key in $allowed.Keys) { $missingModels[$key] = $allowed[$key] }
    $missingModels["PANEL_JARVIS_STT_MODEL"] = (Join-Path $root "missing-model")
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $missingModels).ModelsReady) "Missing local model artifacts must not be ready"

    $emptyConfigPaths = [pscustomobject]@{ RuntimeEnv = (Join-Path $root "empty.runtime.env") }
    New-Item -ItemType Directory -Force -Path (Join-Path $root "empty-config-directory") | Out-Null
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceConfiguration -Paths $emptyConfigPaths).Configured) "An empty config directory is not configuration"

    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @(New-TestVoiceWorker 0) -ConsoleSessionId 2).SessionAligned) "Session 0 worker must be unhealthy"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @(New-TestVoiceWorker 3) -ConsoleSessionId 2).SessionAligned) "Wrong interactive session must be unhealthy"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @((New-TestVoiceWorker 2), (New-TestVoiceWorker 2)) -ConsoleSessionId 2).SessionAligned) "Multiple workers must be unhealthy"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @([pscustomobject]@{}) -ConsoleSessionId 2).SessionAligned) "Unknown worker session must be unhealthy"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @(New-TestVoiceWorker 2) -ConsoleSessionId $null).SessionAligned) "Missing active console must be unhealthy"
    Assert-JarvisVoice ((Get-ArtemJarvisVoiceSessionAlignment -Workers @(New-TestVoiceWorker 2) -ConsoleSessionId 2).SessionAligned) "Exactly one active-console worker must align"

    # This clean venv has no Panel Agent installation. The child sees precisely
    # the two roots which the launcher sets and proves both imports resolve.
    $venv = Join-Path $root "dedicated-voice-venv"
    & python.exe -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Unable to create isolated voice import venv" }
    $python = Join-Path $venv "Scripts\python.exe"
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
    $env:PYTHONPATH = (Join-Path $repoRoot "apps\jarvis-voice\src") + [IO.Path]::PathSeparator + (Join-Path $repoRoot "apps\panel-agent\src")
    $env:PANEL_UNRELATED_SHOULD_NOT_PROPAGATE = "must-not-reach-child"
    $expectedJson = [ordered]@{}
    foreach ($key in (Get-ArtemJarvisVoiceRuntimeKeys)) { $expectedJson[$key] = $allowed[$key] }
    $expectedBytes = [Text.Encoding]::UTF8.GetBytes(($expectedJson | ConvertTo-Json -Compress))
    $env:JARVIS_VOICE_EXPECTED_HASH = ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($expectedBytes))).ToLowerInvariant()
    $null = Set-ArtemJarvisVoiceWorkerEnvironment -Paths $paths
    & $python -c "import hashlib,json,os; import jarvis_voice_worker; import panel_agent.jarvis_voice; keys=['PANEL_JARVIS_VOICE_ENABLED','PANEL_JARVIS_VOICE_BRIDGE_TOKEN','PANEL_JARVIS_VOICE_PANEL_URL','PANEL_JARVIS_VOICE_MODEL_ROOT','PANEL_JARVIS_WAKE_MODEL','PANEL_JARVIS_STT_MODEL','PANEL_JARVIS_STT_PROFILE','PANEL_JARVIS_WAKE_THRESHOLD','PANEL_JARVIS_MIC_DEVICE']; actual={key:os.environ.get(key) for key in keys}; assert hashlib.sha256(json.dumps(actual,separators=(',',':')).encode()).hexdigest()==os.environ['JARVIS_VOICE_EXPECTED_HASH']; assert 'PANEL_UNRELATED_SHOULD_NOT_PROPAGATE' not in os.environ"
    if ($LASTEXITCODE -ne 0) { throw "Dedicated voice child did not receive the exact safe source/runtime contract" }

    $launcher = Get-Content -LiteralPath (Join-Path $PSScriptRoot "run-jarvis-voice.ps1") -Raw
    $installer = Get-Content -LiteralPath (Join-Path $PSScriptRoot "install-jarvis-voice.ps1") -Raw
    $status = Get-Content -LiteralPath (Join-Path $PSScriptRoot "status-jarvis-voice.ps1") -Raw
    $common = Get-Content -LiteralPath (Join-Path $PSScriptRoot "runtime-common.ps1") -Raw
    Assert-JarvisVoice ($installer -match "\$voice\.LauncherScript" -and $common -match "run-jarvis-voice\.ps1") "Scheduled Task must use the owned launcher"
    Assert-JarvisVoice ($launcher -match "apps\\jarvis-voice\\src" -and $launcher -match "apps\\panel-agent\\src") "Launcher must set both source roots"
    Assert-JarvisVoice ($launcher -match "Set-ArtemJarvisVoiceWorkerEnvironment" -and $launcher -notmatch "Invoke-Expression") "Launcher must use safe allow-list loading"
    Assert-JarvisVoice ($status -match "Get-ArtemJarvisVoiceSessionAlignment" -and $status -notmatch "Get-Process -Name explorer") "Status must use canonical console authority"
    Assert-JarvisVoice ($launcher -notmatch "Write-(Host|Output).*BRIDGE_TOKEN" -and $status -notmatch "BRIDGE_TOKEN") "Bridge token must never be printed"
}
finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated Jarvis voice launcher, literal runtime.env allow-list, isolated source imports, session authority and truthful readiness."
