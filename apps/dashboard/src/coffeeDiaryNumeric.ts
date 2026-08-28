export type NumericKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "," | "backspace" | "clear";

export function normalizeNumericInput(value: string, decimal = true, maxLength = 12): string {
  let normalized = value.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  if (!decimal) normalized = normalized.replace(/\./g, "");
  const separator = normalized.indexOf(".");
  if (separator >= 0) normalized = `${normalized.slice(0, separator)}.${normalized.slice(separator + 1).replace(/\./g, "")}`;
  if (normalized.startsWith(".")) normalized = `0${normalized}`;
  return normalized.slice(0, maxLength);
}

export function applyNumericKey(value: string, key: NumericKey, decimal = true, maxLength = 12): string {
  if (key === "clear") return "";
  if (key === "backspace") return value.slice(0, -1);
  if ((key === "." || key === ",") && (!decimal || value.includes("."))) return value;
  return normalizeNumericInput(`${value}${key}`, decimal, maxLength);
}

export function numericInputValue(value: string): number | null {
  if (!value || value.endsWith(".")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
