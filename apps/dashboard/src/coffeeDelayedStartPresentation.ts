export function coffeeDelayTargetLabel(dueAt: string): string {
  const date = new Date(dueAt);
  return Number.isNaN(date.getTime())
    ? "время уточняется"
    : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function coffeeDelayRemainingMinutes(dueAt: string, now: number): number | null {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return null;
  const seconds = Math.ceil((due - now) / 1000);
  return seconds <= 0 ? 0 : Math.max(1, Math.ceil(seconds / 60));
}

export function coffeeDelayCountdownLabel(dueAt: string, now: number): string {
  const minutes = coffeeDelayRemainingMinutes(dueAt, now);
  if (minutes === null) return "время уточняется";
  if (minutes === 0) return "время наступило";
  return `${minutes} мин`;
}
