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
$originalFishApiKey = [Environment]::GetEnvironmentVariable("FISH_API_KEY", "Process")
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
PANEL_JARVIS_TTS_ENABLED=false
PANEL_JARVIS_TTS_MODEL=s2.1-pro-free
PANEL_JARVIS_TTS_REFERENCE_ID=owner-configured-reference
PANEL_JARVIS_TTS_LATENCY=balanced
FISH_API_KEY=runtime-env-secret-must-not-propagate
PANEL_UNRELATED_SHOULD_NOT_PROPAGATE=never
'@
    $runtimeEnvContents.Replace("__VOICE_MODEL_ROOT_VALUE__", $models).Replace("__WAKE_MODEL_VALUE__", $wake).Replace("__STT_MODEL_VALUE__", $stt) |
        Set-Content -LiteralPath $runtimeEnv -Encoding UTF8
    $paths = [pscustomobject]@{ RuntimeEnv = $runtimeEnv }

    $allowed = Get-ArtemJarvisVoiceRuntimeEnvironment -Paths $paths
    Assert-JarvisVoice ($allowed.Count -eq 13) "Only the thirteen explicit non-secret Jarvis voice keys may propagate"
    Assert-JarvisVoice ($allowed["PANEL_JARVIS_VOICE_BRIDGE_TOKEN"] -ceq "bridge=token`$literal") "Token must remain a literal value after the first equals sign"
    Assert-JarvisVoice (-not $allowed.Contains("PANEL_UNRELATED_SHOULD_NOT_PROPAGATE")) "Unrelated PANEL variables must not propagate"
    Assert-JarvisVoice (-not $allowed.Contains("FISH_API_KEY")) "FISH_API_KEY in runtime.env must never be imported"
    $configuration = Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $allowed
    Assert-JarvisVoice ($configuration.Enabled -and $configuration.Configured -and $configuration.ModelsReady) "Complete valid local configuration must be ready"

    $originalCulture = [Globalization.CultureInfo]::CurrentCulture
    try {
        [Globalization.CultureInfo]::CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo("ru-RU")
        $ruConfiguration = Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $allowed
        Assert-JarvisVoice ($ruConfiguration.Configured -and $ruConfiguration.ModelsReady) "Dot-decimal wake threshold must remain valid under ru-RU Windows culture"
    }
    finally {
        [Globalization.CultureInfo]::CurrentCulture = $originalCulture
    }

    $disabled = [ordered]@{}
    foreach ($key in $allowed.Keys) { $disabled[$key] = $allowed[$key] }
    $disabled["PANEL_JARVIS_VOICE_ENABLED"] = "false"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $disabled).Enabled) "Disabled configuration must not start audio"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $disabled).TtsEnabled) "Disabled voice configuration must keep TTS disabled"
    $missingModels = [ordered]@{}
    foreach ($key in $allowed.Keys) { $missingModels[$key] = $allowed[$key] }
    $missingModels["PANEL_JARVIS_STT_MODEL"] = (Join-Path $root "missing-model")
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $missingModels).ModelsReady) "Missing local model artifacts must not be ready"

    $emptyConfigPaths = [pscustomobject]@{ RuntimeEnv = (Join-Path $root "empty.runtime.env") }
    New-Item -ItemType Directory -Force -Path (Join-Path $root "empty-config-directory") | Out-Null
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceConfiguration -Paths $emptyConfigPaths).Configured) "An empty config directory is not configuration"

    $env:FISH_API_KEY = "external-fish-key-fixture"
    $ttsEnabled = [ordered]@{}
    foreach ($key in $allowed.Keys) { $ttsEnabled[$key] = $allowed[$key] }
    $ttsEnabled["PANEL_JARVIS_TTS_ENABLED"] = "true"
    $ttsConfiguration = Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $ttsEnabled
    Assert-JarvisVoice ($ttsConfiguration.TtsEnabled -and $ttsConfiguration.TtsConfigured -and $ttsConfiguration.Configured) "Valid external Fish secret and closed TTS values must configure output"
    Remove-Item -LiteralPath "Env:FISH_API_KEY" -ErrorAction SilentlyContinue
    $missingFishConfiguration = Get-ArtemJarvisVoiceConfiguration -Paths $paths -Environment $ttsEnabled
    Assert-JarvisVoice (-not $missingFishConfiguration.TtsConfigured -and -not $missingFishConfiguration.Configured -and $missingFishConfiguration.ModelsReady) "Missing Fish secret must fail TTS closed without changing local model readiness"
    $env:FISH_API_KEY = "external-fish-key-fixture"

    Set-Content -LiteralPath $emptyConfigPaths.RuntimeEnv -Value "PANEL_JARVIS_VOICE_ENABLED" -Encoding ASCII
    $malformedRejected = $false
    try { Get-ArtemJarvisVoiceRuntimeEnvironment -Paths $emptyConfigPaths | Out-Null }
    catch { $malformedRejected = $_.Exception.Message -eq "Invalid Jarvis voice runtime.env entry" }
    Assert-JarvisVoice $malformedRejected "Malformed owned Jarvis runtime.env keys must fail closed without printing their line"

    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @(New-TestVoiceWorker 0) -ConsoleSessionId 2).SessionAligned) "Session 0 worker must be unhealthy"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @(New-TestVoiceWorker 3) -ConsoleSessionId 2).SessionAligned) "Wrong interactive session must be unhealthy"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @((New-TestVoiceWorker 2), (New-TestVoiceWorker 2)) -ConsoleSessionId 2).SessionAligned) "Multiple workers must be unhealthy"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @([pscustomobject]@{}) -ConsoleSessionId 2).SessionAligned) "Unknown worker session must be unhealthy"
    Assert-JarvisVoice (-not (Get-ArtemJarvisVoiceSessionAlignment -Workers @(New-TestVoiceWorker 2) -ConsoleSessionId $null).SessionAligned) "Missing active console must be unhealthy"
    Assert-JarvisVoice ((Get-ArtemJarvisVoiceSessionAlignment -Workers @(New-TestVoiceWorker 2) -ConsoleSessionId 2).SessionAligned) "Exactly one active-console worker must align"

    $venvLauncher = [pscustomobject]@{ ProcessId = 101; ParentProcessId = 50; SessionId = 2 }
    $baseInterpreter = [pscustomobject]@{ ProcessId = 102; ParentProcessId = 101; SessionId = 2 }
    $secondWorker = [pscustomobject]@{ ProcessId = 201; ParentProcessId = 60; SessionId = 2 }
    $collapsed = @(Get-ArtemJarvisLogicalWorkerRoots -Candidates @($venvLauncher, $baseInterpreter))
    Assert-JarvisVoice ($collapsed.Count -eq 1 -and [int]$collapsed[0].ProcessId -eq 101) "Venv launcher plus base interpreter must count as one logical worker"
    $duplicates = @(Get-ArtemJarvisLogicalWorkerRoots -Candidates @($venvLauncher, $baseInterpreter, $secondWorker))
    Assert-JarvisVoice ($duplicates.Count -eq 2) "Two independent Jarvis process roots must remain a duplicate fault"

    $voice = [pscustomobject]@{ WorkerModule = "jarvis_voice_worker" }
    Assert-JarvisVoice ((Get-ArtemJarvisVoiceStartDecision -Workers @() -TaskState "Ready" -ConsoleSessionId 2).Action -eq "start") "No workers must permit Interactive task start"
    Assert-JarvisVoice ((Get-ArtemJarvisVoiceStartDecision -Workers @(New-TestVoiceWorker 2) -TaskState "Running" -ConsoleSessionId 2).Action -eq "no-op") "One aligned worker must be a no-op"
    Assert-JarvisVoice ((Get-ArtemJarvisVoiceStartDecision -Workers @((New-TestVoiceWorker 2), (New-TestVoiceWorker 2)) -TaskState "Running" -ConsoleSessionId 2).Action -eq "reject") "Multiple workers must reject start"
    Assert-JarvisVoice ((Get-ArtemJarvisVoiceStartDecision -Workers @(New-TestVoiceWorker 0) -TaskState "Running" -ConsoleSessionId 2).Action -eq "restart") "Session 0 task-owned worker must take bounded restart path"
    Assert-JarvisVoice ((Get-ArtemJarvisVoiceStartDecision -Workers @(New-TestVoiceWorker 3) -TaskState "Running" -ConsoleSessionId 2).Action -eq "restart") "Wrong interactive task-owned worker must take bounded restart path"
    Assert-JarvisVoice ((Get-ArtemJarvisVoiceStartDecision -Workers @(New-TestVoiceWorker 0) -TaskState "Ready" -ConsoleSessionId 2).Action -eq "reject") "Misaligned worker outside task lifecycle must reject start"

    $script:startCalls = 0
    $emptyStart = Invoke-ArtemJarvisVoiceStartLifecycle -Voice $voice -Workers @() -TaskState "Ready" -ConsoleSessionId 2 `
        -StartTask { $script:startCalls++ } `
        -WorkerProvider { @() }
    Assert-JarvisVoice ($emptyStart.Action -eq "start" -and $script:startCalls -eq 1) "No workers must invoke scheduled task start exactly once"

    foreach ($misalignedSession in @(0, 3)) {
        $script:stopCalls = 0
        $script:startCalls = 0
        $script:workerPresent = $true
        $restart = Invoke-ArtemJarvisVoiceStartLifecycle -Voice $voice -Workers @(New-TestVoiceWorker $misalignedSession) -TaskState "Running" -ConsoleSessionId 2 `
            -StopTask { $script:stopCalls++; $script:workerPresent = $false } `
            -StartTask { $script:startCalls++ } `
            -WorkerProvider { if ($script:workerPresent) { @(New-TestVoiceWorker $misalignedSession) } else { @() } } `
            -StopTimeoutMilliseconds 3 -PollMilliseconds 1 -Sleep { param($milliseconds) }
        Assert-JarvisVoice ($restart.Action -eq "restart" -and $script:stopCalls -eq 1 -and $script:startCalls -eq 1) "Misaligned running task must stop, wait, then restart exactly once"
    }
    $script:stopCalls = 0
    $script:startCalls = 0
    $timedOut = $false
    try {
        Invoke-ArtemJarvisVoiceStartLifecycle -Voice $voice -Workers @(New-TestVoiceWorker 0) -TaskState "Running" -ConsoleSessionId 2 `
            -StopTask { $script:stopCalls++ } `
            -StartTask { $script:startCalls++ } `
            -WorkerProvider { @(New-TestVoiceWorker 0) } `
            -StopTimeoutMilliseconds 3 -PollMilliseconds 1 -Sleep { param($milliseconds) } | Out-Null
    }
    catch { $timedOut = $_.Exception.Message -eq "Jarvis voice worker did not stop after bounded task shutdown." }
    Assert-JarvisVoice ($timedOut -and $script:stopCalls -eq 1 -and $script:startCalls -eq 0) "Timed-out task stop must reject without restart"

    # A production update must force-restart even an already healthy aligned
    # worker so the process imports the newly checked-out voice code and
    # re-seeds the freshly restarted Panel Agent bridge from STARTING/1.
    $script:restartStopCalls = 0
    $script:restartStartCalls = 0
    $script:restartWorkers = @(New-TestVoiceWorker 2)
    $forcedRestart = Invoke-ArtemJarvisVoiceRestartLifecycle -Voice $voice -Workers @(New-TestVoiceWorker 2) -TaskState "Running" -ConsoleSessionId 2 `
        -StopTask { $script:restartStopCalls++; $script:restartWorkers = @() } `
        -StartTask { $script:restartStartCalls++; $script:restartWorkers = @(New-TestVoiceWorker 2) } `
        -WorkerProvider { @($script:restartWorkers) } `
        -StopTimeoutMilliseconds 3 -StartTimeoutMilliseconds 3 -PollMilliseconds 1 -Sleep { param($milliseconds) }
    Assert-JarvisVoice ($forcedRestart.Action -eq "restart" -and $script:restartStopCalls -eq 1 -and $script:restartStartCalls -eq 1) "Aligned running worker must be force-restarted exactly once after runtime replacement"

    $script:restartStopCalls = 0
    $script:restartStartCalls = 0
    $script:restartWorkers = @()
    $coldStart = Invoke-ArtemJarvisVoiceRestartLifecycle -Voice $voice -Workers @() -TaskState "Ready" -ConsoleSessionId 2 `
        -StopTask { $script:restartStopCalls++ } `
        -StartTask { $script:restartStartCalls++; $script:restartWorkers = @(New-TestVoiceWorker 2) } `
        -WorkerProvider { @($script:restartWorkers) } `
        -StopTimeoutMilliseconds 3 -StartTimeoutMilliseconds 3 -PollMilliseconds 1 -Sleep { param($milliseconds) }
    Assert-JarvisVoice ($coldStart.Action -eq "start" -and $script:restartStopCalls -eq 0 -and $script:restartStartCalls -eq 1) "Stopped voice task must start once without a redundant stop"

    $unownedRestartRejected = $false
    try {
        Invoke-ArtemJarvisVoiceRestartLifecycle -Voice $voice -Workers @(New-TestVoiceWorker 2) -TaskState "Ready" -ConsoleSessionId 2 `
            -StopTask { } -StartTask { } -WorkerProvider { @(New-TestVoiceWorker 2) } `
            -StopTimeoutMilliseconds 3 -StartTimeoutMilliseconds 3 -PollMilliseconds 1 -Sleep { param($milliseconds) } | Out-Null
    }
    catch { $unownedRestartRejected = $_.Exception.Message -eq "Refusing to restart an unowned Jarvis voice worker." }
    Assert-JarvisVoice $unownedRestartRejected "Updater must never kill or duplicate a worker that is not owned by the Running task"
    # This clean venv has no Panel Agent installation. The child sees precisely
    # the two roots which the launcher sets and proves both imports resolve.
    $venv = Join-Path $root "dedicated-voice-venv"
    & python.exe -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Unable to create isolated voice import venv" }
    $python = Join-Path $venv "Scripts\python.exe"
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
    $env:PYTHONPATH = (Join-Path $repoRoot "apps\jarvis-voice\src") + [IO.Path]::PathSeparator + (Join-Path $repoRoot "apps\panel-agent\src")
    $env:PANEL_UNRELATED_SHOULD_NOT_PROPAGATE = "must-not-reach-child"
    $expectedNonEmpty = [ordered]@{}
    foreach ($key in (Get-ArtemJarvisVoiceRuntimeKeys)) {
        if (-not [string]::IsNullOrEmpty([string]$allowed[$key])) { $expectedNonEmpty[$key] = $allowed[$key] }
    }
    $env:JARVIS_VOICE_EXPECTED_JSON = $expectedNonEmpty | ConvertTo-Json -Compress
    $null = Set-ArtemJarvisVoiceWorkerEnvironment -Paths $paths
    & $python -c "import json,os; expected=json.loads(os.environ.pop('JARVIS_VOICE_EXPECTED_JSON')); import jarvis_voice_worker; import panel_agent.jarvis_voice; assert all(key in os.environ and os.environ[key] == value for key,value in expected.items()); assert 'PANEL_JARVIS_MIC_DEVICE' not in os.environ; assert 'PANEL_UNRELATED_SHOULD_NOT_PROPAGATE' not in os.environ; assert os.environ.get('FISH_API_KEY') == 'external-fish-key-fixture'"
    if ($LASTEXITCODE -ne 0) { throw "Dedicated voice child did not receive the exact safe source/runtime contract" }

    $launcher = Get-Content -LiteralPath (Join-Path $PSScriptRoot "run-jarvis-voice.ps1") -Raw
    $starter = Get-Content -LiteralPath (Join-Path $PSScriptRoot "start-jarvis-voice.ps1") -Raw
    $installer = Get-Content -LiteralPath (Join-Path $PSScriptRoot "install-jarvis-voice.ps1") -Raw
    $status = Get-Content -LiteralPath (Join-Path $PSScriptRoot "status-jarvis-voice.ps1") -Raw
    $common = Get-Content -LiteralPath (Join-Path $PSScriptRoot "runtime-common.ps1") -Raw
    Assert-JarvisVoice ($installer -match '\$voice\.LauncherScript' -and $common -match "run-jarvis-voice\.ps1") "Scheduled Task must use the owned launcher"
    Assert-JarvisVoice ($launcher -match "apps\\jarvis-voice\\src" -and $launcher -match "apps\\panel-agent\\src") "Launcher must set both source roots"
    Assert-JarvisVoice ($launcher -match "Set-ArtemJarvisVoiceWorkerEnvironment" -and $launcher -notmatch "Invoke-Expression") "Launcher must use safe allow-list loading"
    Assert-JarvisVoice ($starter -match "Invoke-ArtemJarvisVoiceStartLifecycle" -and $starter -notmatch "Stop-Process") "Starter must use bounded task-owned lifecycle logic only"
    Assert-JarvisVoice ($status -match "Get-ArtemJarvisVoiceSessionAlignment" -and $status -notmatch "Get-Process -Name explorer") "Status must use canonical console authority"
    Assert-JarvisVoice ($launcher -notmatch "Write-(Host|Output).*BRIDGE_TOKEN" -and $status -notmatch "BRIDGE_TOKEN") "Bridge token must never be printed"
    Assert-JarvisVoice ($status -notmatch "FISH_API_KEY") "Fish API key must never be rendered by status"
}
finally {
    if ($null -eq $originalFishApiKey) { Remove-Item -LiteralPath "Env:FISH_API_KEY" -ErrorAction SilentlyContinue }
    else { $env:FISH_API_KEY = $originalFishApiKey }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Validated Jarvis voice launcher, literal runtime.env allow-list, isolated source imports, session authority and truthful readiness."
