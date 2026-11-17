export function formatPanelDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

/** Some providers already send a complete owner-facing phrase, others an ISO timestamp. */
export function formatFreshnessLabel(value: string): string {
  return value.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g,
    (timestamp) => formatPanelDate(timestamp));
}
