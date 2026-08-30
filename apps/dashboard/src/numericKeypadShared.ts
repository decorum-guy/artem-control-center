export type NumericKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "," | "backspace" | "clear";

export function numericKeyOrder(decimal: boolean): NumericKey[] {
  return ["1", "2", "3", "4", "5", "6", "7", "8", "9", "backspace", "0", decimal ? "." : "clear"];
}

export function numericKeyLabel(key: NumericKey, clearLabel: string, backspaceLabel = "←"): string {
  if (key === "backspace") return backspaceLabel;
  if (key === ".") return ",";
  if (key === "clear") return clearLabel;
  return key;
}
