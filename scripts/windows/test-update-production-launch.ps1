$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$runtimeModule = (Resolve-Path (Join-Path $repoRoot "scripts\production-runtime.mjs")).Path
$launcherSource = Join-Path $PSScriptRoot "launch-update-production.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("artem-update-launch-{0}" -f [guid]::NewGuid())
$fixtureRepo = Join-Path $testRoot "repo"
$fixtureScripts = Join-Path $fixtureRepo "scripts\windows"
$fixtureUpdaterPath = Join-Path $fixtureScripts "update-production.ps1"
$fixtureLauncherPath = Join-Path $fixtureScripts "launch-update-production.ps1"
$parentScript = Join-Path $testRoot "fake-runtime-parent.mjs"
$failureHarness = Join-Path $testRoot "launch-failure-harness.mjs"
$previousLocalAppData = $env:LOCALAPPDATA
$environmentNames = @(
    "ARTEM_RUNTIME_MODULE",
    "ARTEM_FIXTURE_REPO",
    "ARTEM_FIXTURE_MODE",
    "ARTEM_FIXTURE_MARKER_A",
    "ARTEM_FIXTURE_MARKER_B",
    "ARTEM_FIXTURE_EXIT",
    "ARTEM_FIXTURE_CONTINUE",
    "ARTEM_PARENT_RESULT",
    "ARTEM_PARENT_HOLD",
    "ARTEM_EXPECTED_CURRENT",
    "ARTEM_EXPECTED_TARGET",
    "ARTEM_REQUEST_ID",
    "ARTEM_FAILURE_STATE",
    "ARTEM_FAILURE_LOCK",
    "ARTEM_FAILURE_RECEIPT",
    "ARTEM_FAILURE_BOOTSTRAP",
    "ARTEM_FAILURE_RESULT"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$survivalParent = $null
$entryParent = $null

function Wait-ArtemFixtureFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int]$TimeoutMilliseconds = 10000
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Timed out waiting for fixture file: $Path"
        }
        Start-Sleep -Milliseconds 50
    }
}

function Assert-ArtemFixture {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

$fixtureUpdater = @'
param(
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedCurrentHead,
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedTargetHead,
    [ValidatePattern('^[0-9a-f]{24}$')]
    [string]$RequestId
)

$ErrorActionPreference = "Stop"
$payload = [ordered]@{
    expectedCurrentHead = $ExpectedCurrentHead
    expectedTargetHead = $ExpectedTargetHead
    requestId = $RequestId
}
$payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:ARTEM_FIXTURE_MARKER_A -Encoding ASCII

if ($env:ARTEM_FIXTURE_MODE -eq "survival") {
    while (-not (Test-Path -LiteralPath $env:ARTEM_FIXTURE_CONTINUE -PathType Leaf)) {
        Start-Sleep -Milliseconds 50
    }
    Set-Content -LiteralPath $env:ARTEM_FIXTURE_MARKER_B -Value "survived-runtime-stop" -Encoding ASCII
}

Set-Content -LiteralPath $env:ARTEM_FIXTURE_EXIT -Value "normal-exit" -Encoding ASCII
exit 0
'@

$parentSource = @'
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { spawnWindowsUpdaterLauncher } = await import(
  pathToFileURL(process.env.ARTEM_RUNTIME_MODULE).href
);
const command = {
  schemaVersion: 1,
  action: "update_panel",
  expectedCurrentHead: process.env.ARTEM_EXPECTED_CURRENT,
  expectedTargetHead: process.env.ARTEM_EXPECTED_TARGET,
  requestId: process.env.ARTEM_REQUEST_ID,
  requestedAt: "2026-08-26T12:00:00.000Z"
};
const launcher = spawnWindowsUpdaterLauncher({
  root: process.env.ARTEM_FIXTURE_REPO,
  command
});
launcher.once("error", (error) => {
  writeFileSync(process.env.ARTEM_PARENT_RESULT, JSON.stringify({
    event: "error",
    message: String(error?.message || error)
  }));
  process.exitCode = 1;
});
launcher.once("exit", (code, signal) => {
  writeFileSync(process.env.ARTEM_PARENT_RESULT, JSON.stringify({
    event: "exit",
    code,
    signal
  }));
  if (process.env.ARTEM_PARENT_HOLD !== "true") process.exit(code ?? 1);
});
if (process.env.ARTEM_PARENT_HOLD === "true") setInterval(() => {}, 1000);
'@

$failureHarnessSource = @'
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const runtime = await import(pathToFileURL(process.env.ARTEM_RUNTIME_MODULE).href);
const command = {
  schemaVersion: 1,
  action: "update_panel",
  expectedCurrentHead: process.env.ARTEM_EXPECTED_CURRENT,
  expectedTargetHead: process.env.ARTEM_EXPECTED_TARGET,
  requestId: process.env.ARTEM_REQUEST_ID,
  requestedAt: "2026-08-26T12:00:00.000Z"
};
const statePath = process.env.ARTEM_FAILURE_STATE;
const lockPath = process.env.ARTEM_FAILURE_LOCK;
const receiptPath = process.env.ARTEM_FAILURE_RECEIPT;
const resultPath = process.env.ARTEM_FAILURE_RESULT;
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};
const launcher = runtime.spawnWindowsUpdaterLauncher({
  root: process.env.ARTEM_FIXTURE_REPO,
  command
});
let finished = false;
const finish = (exitCode, payload) => {
  if (finished) return;
  finished = true;
  writeFileSync(resultPath, JSON.stringify(payload));
  process.exit(exitCode);
};
runtime.createPanelUpdateLauncherLifecycle({
  command,
  launcher,
  isRuntimeAlive: () => true,
  hasAuthoritativeEvidence: () => {
    const state = readJson(statePath);
    return Boolean(state && ["success", "failed"].includes(state.status));
  },
  readBootstrapEvidence: () => runtime.readUpdaterBootstrapEvidence(
    process.env.ARTEM_FAILURE_BOOTSTRAP,
    command.requestId
  ),
  readLaunchEvidence: () => runtime.readUpdaterLaunchEvidence(receiptPath, command.requestId),
  isUpdaterProcessAlive: () => false,
  publishFailure: (result) => {
    const state = readJson(statePath);
    const lock = readJson(lockPath);
    const allowed = runtime.canPublishPanelUpdateRuntimeFailure({ command, state, lock });
    if (!allowed) {
      finish(1, { result: "false_success", allowed });
      return false;
    }
    writeFileSync(statePath, JSON.stringify({
      ...state,
      status: "failed",
      result,
      updatedAt: new Date().toISOString()
    }));
    if (runtime.isExactPanelUpdateLock(lock, command, { ownerless: true })) rmSync(lockPath, { force: true });
    finish(0, {
      result,
      stateResult: readJson(statePath)?.result,
      lockExists: existsSync(lockPath),
      receipt: readJson(receiptPath)
    });
    return true;
  },
  log: () => {}
});
setTimeout(() => finish(1, { result: "timeout" }), 5000);
'@

try {
    New-Item -ItemType Directory -Force -Path $fixtureScripts | Out-Null
    Copy-Item -LiteralPath $launcherSource -Destination $fixtureLauncherPath
    Set-Content -LiteralPath $fixtureUpdaterPath -Value $fixtureUpdater -Encoding ASCII
    Set-Content -LiteralPath $parentScript -Value $parentSource -Encoding UTF8
    Set-Content -LiteralPath $failureHarness -Value $failureHarnessSource -Encoding UTF8

    $currentHead = "a" * 40
    $targetHead = "b" * 40
    $requestId = "0123456789abcdef01234567"
    $entryAppData = Join-Path $testRoot "entry-localappdata"
    $entryMarker = Join-Path $testRoot "entry-marker.json"
    $entryExit = Join-Path $testRoot "entry-exit.txt"
    $entryParentResult = Join-Path $testRoot "entry-parent-result.json"

    $env:ARTEM_RUNTIME_MODULE = $runtimeModule
    $env:ARTEM_FIXTURE_REPO = $fixtureRepo
    $env:ARTEM_FIXTURE_MODE = "entry"
    $env:ARTEM_FIXTURE_MARKER_A = $entryMarker
    $env:ARTEM_FIXTURE_MARKER_B = Join-Path $testRoot "entry-marker-b.txt"
    $env:ARTEM_FIXTURE_EXIT = $entryExit
    $env:ARTEM_FIXTURE_CONTINUE = Join-Path $testRoot "entry-continue.flag"
    $env:ARTEM_PARENT_RESULT = $entryParentResult
    $env:ARTEM_PARENT_HOLD = "false"
    $env:ARTEM_EXPECTED_CURRENT = $currentHead
    $env:ARTEM_EXPECTED_TARGET = $targetHead
    $env:ARTEM_REQUEST_ID = $requestId
    $env:LOCALAPPDATA = $entryAppData

    $entryParent = Start-Process `
        -FilePath "node.exe" `
        -ArgumentList ('"{0}"' -f $parentScript) `
        -WorkingDirectory $fixtureRepo `
        -PassThru `
        -Wait
    Assert-ArtemFixture -Condition ($entryParent.ExitCode -eq 0) -Message "Node launcher entry parent failed"
    Wait-ArtemFixtureFile -Path $entryMarker
    Wait-ArtemFixtureFile -Path $entryExit
    Wait-ArtemFixtureFile -Path $entryParentResult
    $entryPayload = Get-Content -LiteralPath $entryMarker -Raw | ConvertFrom-Json
    Assert-ArtemFixture -Condition ($entryPayload.expectedCurrentHead -eq $currentHead) -Message "Updater fixture received the wrong current SHA"
    Assert-ArtemFixture -Condition ($entryPayload.expectedTargetHead -eq $targetHead) -Message "Updater fixture received the wrong target SHA"
    Assert-ArtemFixture -Condition ($entryPayload.requestId -eq $requestId) -Message "Updater fixture received the wrong request id"
    $entryResult = Get-Content -LiteralPath $entryParentResult -Raw | ConvertFrom-Json
    Assert-ArtemFixture -Condition ($entryResult.event -eq "exit" -and $entryResult.code -eq 0) -Message "Launcher process did not exit cleanly"
    $entryReceiptPath = Join-Path $entryAppData "ArtemControlCenter\update-launch.json"
    Wait-ArtemFixtureFile -Path $entryReceiptPath
    $entryReceipt = Get-Content -LiteralPath $entryReceiptPath -Raw | ConvertFrom-Json
    Assert-ArtemFixture -Condition ($entryReceipt.requestId -eq $requestId) -Message "Launch receipt request id is not correlated"
    Assert-ArtemFixture -Condition ($entryReceipt.stage -eq "runtime-process-created" -and $entryReceipt.result -eq "recorded") -Message "Launch receipt did not prove actual process creation"
    Assert-ArtemFixture -Condition ([int]$entryReceipt.processId -gt 0) -Message "Launch receipt did not contain a valid private process identity"

    # Regression 2: the fixture updater is the actual script body and waits on
    # a file event.  The launcher must be gone before this exact production
    # process-tree boundary is applied.
    $survivalAppData = Join-Path $testRoot "survival-localappdata"
    $survivalMarkerA = Join-Path $testRoot "survival-marker-a.json"
    $survivalMarkerB = Join-Path $testRoot "survival-marker-b.txt"
    $survivalExit = Join-Path $testRoot "survival-exit.txt"
    $survivalContinue = Join-Path $testRoot "survival-continue.flag"
    $survivalParentResult = Join-Path $testRoot "survival-parent-result.json"
    $env:ARTEM_FIXTURE_MODE = "survival"
    $env:ARTEM_FIXTURE_MARKER_A = $survivalMarkerA
    $env:ARTEM_FIXTURE_MARKER_B = $survivalMarkerB
    $env:ARTEM_FIXTURE_EXIT = $survivalExit
    $env:ARTEM_FIXTURE_CONTINUE = $survivalContinue
    $env:ARTEM_PARENT_RESULT = $survivalParentResult
    $env:ARTEM_PARENT_HOLD = "true"
    $env:LOCALAPPDATA = $survivalAppData

    $survivalParent = Start-Process `
        -FilePath "node.exe" `
        -ArgumentList ('"{0}"' -f $parentScript) `
        -WorkingDirectory $fixtureRepo `
        -PassThru
    Wait-ArtemFixtureFile -Path $survivalMarkerA
    Wait-ArtemFixtureFile -Path $survivalParentResult
    $survivalResult = Get-Content -LiteralPath $survivalParentResult -Raw | ConvertFrom-Json
    Assert-ArtemFixture -Condition ($survivalResult.event -eq "exit" -and $survivalResult.code -eq 0) -Message "Launcher did not exit before runtime tree termination"

    & taskkill.exe /PID ([string]$survivalParent.Id) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Production-equivalent taskkill /T could not terminate fake runtime parent" }
    $survivalParent.Refresh()
    Assert-ArtemFixture -Condition $survivalParent.HasExited -Message "Fake runtime parent survived taskkill"
    Set-Content -LiteralPath $survivalContinue -Value "continue" -Encoding ASCII
    Wait-ArtemFixtureFile -Path $survivalMarkerB
    Wait-ArtemFixtureFile -Path $survivalExit
    Assert-ArtemFixture -Condition ((Get-Content -LiteralPath $survivalMarkerB -Raw).Trim() -eq "survived-runtime-stop") -Message "Updater did not survive production runtime tree termination"
    Assert-ArtemFixture -Condition ((Get-Content -LiteralPath $survivalExit -Raw).Trim() -eq "normal-exit") -Message "Surviving updater fixture did not exit normally"

    # Regression 3: a launcher can report a bounded failure, but that receipt
    # must never be treated as actual updater success or leave the ownerless
    # handoff lease active.
    $failureRepo = Join-Path $testRoot "failure-repo"
    $failureScripts = Join-Path $failureRepo "scripts\windows"
    New-Item -ItemType Directory -Force -Path $failureScripts | Out-Null
    Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $failureScripts "launch-update-production.ps1")
    $failureAppData = Join-Path $testRoot "failure-localappdata"
    $failureRuntimeRoot = Join-Path $failureAppData "ArtemControlCenter"
    New-Item -ItemType Directory -Force -Path $failureRuntimeRoot | Out-Null
    $failureStatePath = Join-Path $failureRuntimeRoot "update-state.json"
    $failureLockPath = Join-Path $failureRuntimeRoot "update-lock.json"
    $failureReceiptPath = Join-Path $failureRuntimeRoot "update-launch.json"
    $failureBootstrapPath = Join-Path $failureRuntimeRoot "update-bootstrap.json"
    $failureResultPath = Join-Path $testRoot "failure-result.json"
    $failureState = @{
        schemaVersion = 1
        status = "updating"
        requestId = $requestId
        currentHead = $currentHead
        targetHead = $targetHead
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    $failureLock = @{
        schemaVersion = 1
        status = "updating"
        requestId = $requestId
        expectedCurrentHead = $currentHead
        expectedTargetHead = $targetHead
        updatedAt = [DateTime]::UtcNow.ToString("o")
    }
    $failureState | ConvertTo-Json -Compress | Set-Content -LiteralPath $failureStatePath -Encoding ASCII
    $failureLock | ConvertTo-Json -Compress | Set-Content -LiteralPath $failureLockPath -Encoding ASCII
    $env:ARTEM_FIXTURE_REPO = $failureRepo
    $env:ARTEM_FAILURE_STATE = $failureStatePath
    $env:ARTEM_FAILURE_LOCK = $failureLockPath
    $env:ARTEM_FAILURE_RECEIPT = $failureReceiptPath
    $env:ARTEM_FAILURE_BOOTSTRAP = $failureBootstrapPath
    $env:ARTEM_FAILURE_RESULT = $failureResultPath
    $env:LOCALAPPDATA = $failureAppData
    $failureParent = Start-Process `
        -FilePath "node.exe" `
        -ArgumentList ('"{0}"' -f $failureHarness) `
        -WorkingDirectory $failureRepo `
        -PassThru `
        -Wait
    Assert-ArtemFixture -Condition ($failureParent.ExitCode -eq 0) -Message "Launch failure lifecycle harness failed"
    Wait-ArtemFixtureFile -Path $failureResultPath
    $failureResult = Get-Content -LiteralPath $failureResultPath -Raw | ConvertFrom-Json
    Assert-ArtemFixture -Condition ($failureResult.result -eq "updater_spawn_failed") -Message "Launcher failure was not classified as updater_spawn_failed"
    Assert-ArtemFixture -Condition ($failureResult.stateResult -eq "updater_spawn_failed") -Message "Owner did not receive the bounded launch failure state"
    Assert-ArtemFixture -Condition (-not [bool]$failureResult.lockExists) -Message "Ownerless provisional lock was not released after launch failure"
    Assert-ArtemFixture -Condition ($failureResult.receipt.result -eq "child-start-failed" -and $null -eq $failureResult.receipt.processId) -Message "Launch failure receipt was not narrow and process-free"

    Write-Host "Validated updater script entry, taskkill /T process-tree survival, and bounded launch failure ownership."
}
finally {
    if ($survivalContinue) {
        Set-Content -LiteralPath $survivalContinue -Value "cleanup" -Encoding ASCII -ErrorAction SilentlyContinue
    }
    foreach ($process in @($entryParent, $survivalParent)) {
        if ($null -ne $process) {
            try {
                $process.Refresh()
                if (-not $process.HasExited) {
                    & taskkill.exe /PID ([string]$process.Id) /T /F | Out-Null
                }
            }
            catch { }
        }
    }
    $env:LOCALAPPDATA = $previousLocalAppData
    foreach ($name in $environmentNames) {
        $previous = $previousEnvironment[$name]
        if ($null -eq $previous) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -Path "Env:$name" -Value $previous
        }
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
