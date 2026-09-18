export type JarvisVoiceState = "disabled" | "starting" | "idle" | "wake_detected" | "listening" | "transcribing" | "submitting" | "ready" | "error" | "cooldown";
export type JarvisVoiceHealth = "disabled" | "unconfigured" | "starting" | "healthy" | "degraded" | "unavailable";

export interface JarvisVoiceSnapshot {
  schemaVersion: "jarvis.voice.v1";
  enabled: boolean;
  configured: boolean;
  health: JarvisVoiceHealth;
  state: JarvisVoiceState;
  sequence: number;
  recognizedText: string | null;
  responseText: string | null;
  safeErrorCode: string | null;
  wakeLatencyMs: number | null;
  sttLatencyMs: number | null;
}

const states = new Set<JarvisVoiceState>(["disabled", "starting", "idle", "wake_detected", "listening", "transcribing", "submitting", "ready", "error", "cooldown"]);
const health = new Set<JarvisVoiceHealth>(["disabled", "unconfigured", "starting", "healthy", "degraded", "unavailable"]);

export function parseJarvisVoiceSnapshot(value: unknown): JarvisVoiceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== "jarvis.voice.v1" || typeof item.enabled !== "boolean" || typeof item.configured !== "boolean" ||
      typeof item.sequence !== "number" || !Number.isInteger(item.sequence) || item.sequence < 0 ||
      typeof item.state !== "string" || !states.has(item.state as JarvisVoiceState) ||
      typeof item.health !== "string" || !health.has(item.health as JarvisVoiceHealth)) return null;
  const numeric = (field: string) => item[field] === null || (typeof item[field] === "number" && Number.isFinite(item[field]) && item[field] >= 0);
  if (!numeric("wakeLatencyMs") || !numeric("sttLatencyMs") || (item.safeErrorCode !== null && typeof item.safeErrorCode !== "string")) return null;
  if ((item.recognizedText !== null && typeof item.recognizedText !== "string") || (item.responseText !== null && typeof item.responseText !== "string")) return null;
  return item as unknown as JarvisVoiceSnapshot;
}

export async function getJarvisVoiceState(signal?: AbortSignal): Promise<JarvisVoiceSnapshot | null> {
  const response = await fetch("/api/v1/jarvis/voice/state", { cache: "no-store", signal });
  if (!response.ok) return null;
  return parseJarvisVoiceSnapshot(await response.json());
}

export async function syncJarvisVoiceInteractionLock(locked: boolean): Promise<void> {
  await fetch("/api/v1/jarvis/voice/interaction-lock", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locked })
  });
}
