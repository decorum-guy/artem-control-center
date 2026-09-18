import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const core = read("../../apps/panel-agent/src/panel_agent/jarvis_voice.py");
const bridge = read("../../apps/panel-agent/src/panel_agent/jarvis_voice_api.py");
const install = read("../windows/install-jarvis-voice.ps1");
const launcher = read("../windows/run-jarvis-voice.ps1");
const start = read("../windows/start-jarvis-voice.ps1");
const status = read("../windows/status-jarvis-voice.ps1");
const runtime = read("../windows/runtime-common.ps1");
const windowsContract = read("../windows/test-jarvis-voice-contract.ps1");
const ci = read("../../.github/workflows/ci.yml");

test("voice core is bounded, adapter-only, and has no persistence primitive", () => {
  assert.match(core, /class AudioInput\(Protocol\)/);
  assert.match(core, /class WakeDetector\(Protocol\)/);
  assert.match(core, /class VoiceActivityDetector\(Protocol\)/);
  assert.match(core, /class SpeechRecognizer\(Protocol\)/);
  assert.match(core, /class JarvisTurnClient\(Protocol\)/);
  assert.match(core, /class VoiceStatePublisher\(Protocol\)/);
  assert.match(core, /pre_roll_ms: int = 500/);
  assert.match(core, /max_utterance_ms: int = 12_000/);
  assert.match(core, /trailing_silence_ms: int = 800/);
  assert.doesNotMatch(core, /open\(|wave\.|\.wav|\.pcm|\.raw|subprocess|os\.system/);
});

test("voice bridge has one authenticated, non-mutating JarvisTurnService path", () => {
  assert.match(bridge, /hmac\.compare_digest/);
  assert.match(bridge, /return await service\.turn\(request\.text\)/);
  assert.match(bridge, /HTTP_423_LOCKED/);
  assert.match(bridge, /Cache-Control.*no-store/);
  assert.doesNotMatch(bridge, /Home Assistant|shell|subprocess|actionId|intentId/);
});

test("Windows voice task is interactive, launcher-owned, optional, and session-authoritative", () => {
  assert.match(runtime, /Artem Control Center Jarvis Voice/);
  assert.match(install, /-LogonType Interactive/);
  assert.match(install, /-RunLevel Limited/);
  assert.match(install, /\$voice\.LauncherScript/);
  assert.match(runtime, /LauncherScript = Join-Path \$Paths\.RepoRoot "scripts\\windows\\run-jarvis-voice\.ps1"/);
  assert.match(launcher, /apps\\jarvis-voice\\src/);
  assert.match(launcher, /apps\\panel-agent\\src/);
  assert.match(launcher, /Set-ArtemJarvisVoiceWorkerEnvironment/);
  assert.match(launcher, /& \$python -m \$voice\.WorkerModule/);
  assert.doesNotMatch(launcher, /Invoke-Expression/);
  assert.match(runtime, /function Get-ArtemJarvisVoiceRuntimeEnvironment/);
  assert.match(runtime, /function Set-ArtemJarvisVoiceWorkerEnvironment/);
  assert.match(runtime, /function Get-ArtemJarvisVoiceStartDecision/);
  assert.match(runtime, /function Invoke-ArtemJarvisVoiceStartLifecycle/);
  assert.match(runtime, /PANEL_JARVIS_VOICE_BRIDGE_TOKEN/);
  assert.match(runtime, /function Get-ArtemJarvisVoiceSessionAlignment/);
  assert.match(runtime, /Refusing to start duplicate Jarvis voice workers/);
  assert.match(start, /Invoke-ArtemJarvisVoiceStartLifecycle/);
  assert.match(status, /Get-ArtemJarvisVoiceSessionAlignment/);
  assert.match(runtime, /Get-ArtemActiveConsoleSessionId/);
  assert.doesNotMatch(status, /Get-Process -Name explorer/);
  assert.match(ci, /test-jarvis-voice-contract\.ps1/);
  assert.doesNotMatch(windowsContract, /HashData|ToHexString/);
  assert.match(runtime, /jarvis-voice/);
  for (const source of [install, launcher, start, status, runtime]) {
    assert.doesNotMatch(source, /PsExec|CreateProcessAsUser|New-Service/);
  }
});

test("owner RVC artifacts are identity-pinned but not voice-input models", () => {
  const manifest = JSON.parse(read("../../apps/jarvis-voice/models.manifest.json"));
  assert.equal(manifest.rvc.purpose, "future output timbre conversion only");
  assert.equal(manifest.wake.physicalAcceptance, false);
  assert.equal(manifest.stt.physicalAcceptance, false);
  for (const asset of manifest.rvc.assets) {
    const content = readFileSync(new URL(`../../${asset.path}`, import.meta.url));
    assert.equal(createHash("sha256").update(content).digest("hex"), asset.sha256);
  }
});
