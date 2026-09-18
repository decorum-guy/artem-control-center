export type JarvisNavigation = "/overview" | "/calendar" | "/tasks" | "/reminders" | "/settings" | "/system" | "/coffee-diary";

export interface JarvisTurnResponse {
  schemaVersion: "jarvis.turn.v1";
  status: "ready" | "unavailable" | "cancelled";
  intentId: string;
  responseText: string;
  navigation: JarvisNavigation | null;
}

export async function sendJarvisTurn(text: string, signal?: AbortSignal): Promise<JarvisTurnResponse> {
  const response = await fetch("/api/v1/jarvis/turn", {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ text }),
    signal
  });
  if (!response.ok) throw new Error("jarvis_turn_unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("jarvis_turn_invalid");
  const turn = value as Partial<JarvisTurnResponse>;
  if (
    turn.schemaVersion !== "jarvis.turn.v1"
    || !["ready", "unavailable", "cancelled"].includes(String(turn.status))
    || typeof turn.intentId !== "string"
    || typeof turn.responseText !== "string"
    || turn.responseText.length > 500
    || (turn.navigation !== null && turn.navigation !== undefined && ![
      "/overview", "/calendar", "/tasks", "/reminders", "/settings", "/system", "/coffee-diary"
    ].includes(String(turn.navigation)))
  ) throw new Error("jarvis_turn_invalid");
  return { ...turn, navigation: turn.navigation ?? null } as JarvisTurnResponse;
}
