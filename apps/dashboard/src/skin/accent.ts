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
