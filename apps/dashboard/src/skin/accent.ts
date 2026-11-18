export const accents = { ice: "Лёд", iris: "Ирис", lagoon: "Лагуна", rose: "Розовый кварц" } as const;
export type Accent = keyof typeof accents;

const storageKey = "artem-control-center.accent";

export function readAccent(): Accent {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && Object.hasOwn(accents, stored)) return stored as Accent;
  } catch {
    // Local storage may be unavailable in a temporary kiosk profile.
  }
  return "ice";
}

export function persistAccent(accent: Accent) {
  try { localStorage.setItem(storageKey, accent); } catch { /* Keep this session's selection. */ }
}


export function readColorMode(): "day" | "night" {
  try { return localStorage.getItem("artem-control-center.color-mode") === "day" ? "day" : "night"; }
  catch { return "night"; }
}

export function persistColorMode(mode: "day" | "night") {
  try { localStorage.setItem("artem-control-center.color-mode", mode); } catch { /* Session only. */ }
}

export type Appearance = { accent?: Accent; colorMode?: "day" | "night" };

export function explicitlyStoredAppearance(): Appearance {
  try {
    const accent = localStorage.getItem(storageKey);
    const mode = localStorage.getItem("artem-control-center.color-mode");
    return {
      ...(accent && Object.hasOwn(accents, accent) ? { accent: accent as Accent } : {}),
      ...(mode === "day" || mode === "night" ? { colorMode: mode } : {})
    };
  } catch { return {}; }
}

export async function loadAppearance(signal: AbortSignal): Promise<Appearance> {
  const response = await fetch("/api/v1/settings/appearance", { cache: "no-store", signal });
  if (!response.ok) throw new Error("appearance_unavailable");
  const value = await response.json();
  return {
    ...(typeof value?.accent === "string" && Object.hasOwn(accents, value.accent) ? { accent: value.accent as Accent } : {}),
    ...(value?.colorMode === "day" || value?.colorMode === "night" ? { colorMode: value.colorMode as "day" | "night" } : {})
  };
}

export async function saveAppearance(change: Appearance): Promise<void> {
  const response = await fetch("/api/v1/settings/appearance", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change)
  });
  if (!response.ok) throw new Error("appearance_write_failed");
}
