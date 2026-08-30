export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 12;

import type { NumericKey } from "./numericKeypadShared";

export type PinKey = Exclude<NumericKey, "." | ",">;

export function normalizePin(value: string): string {
  return value.replace(/\D/g, "").slice(0, PIN_MAX_LENGTH);
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^[0-9]{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

export function applyPinKey(pin: string, key: PinKey): string {
  if (key === "clear") return "";
  if (key === "backspace") return pin.slice(0, -1);
  if (pin.length >= PIN_MAX_LENGTH) return pin;
  return `${pin}${key}`;
}
