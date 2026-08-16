export type EventMutationSheetMode = "create" | "edit";

export type EventMutationBody = {
  title?: string;
  notes?: string | null;
  location?: string | null;
  all_day?: boolean;
  timezone?: string;
  start_at_utc?: string | null;
  end_at_utc?: string | null;
  start_date?: string | null;
  end_date_exclusive?: string | null;
};

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

/**
 * Convert only fields owned by the canonical event parser into an Alice-safe
 * mutation body. Edit deliberately omits notes/location unless a future
 * parser contract explicitly owns those fields.
 */
export function eventMutationBodyFromPreview(
  mode: EventMutationSheetMode,
  fields: Record<string, unknown>,
  acceptProposedEnd = false
): EventMutationBody {
  const body: EventMutationBody = {};
  if (typeof fields.title === "string") body.title = fields.title;
  if (typeof fields.all_day === "boolean") body.all_day = fields.all_day;
  if (typeof fields.timezone === "string") body.timezone = fields.timezone;

  if (fields.all_day === true) {
    if (typeof fields.start_date === "string") body.start_date = fields.start_date;
    if (typeof fields.end_date_exclusive === "string") body.end_date_exclusive = fields.end_date_exclusive;
    body.start_at_utc = null;
    body.end_at_utc = null;
  } else {
    if (typeof fields.start_at_utc === "string") body.start_at_utc = fields.start_at_utc;
    const end = typeof fields.end_at_utc === "string"
      ? fields.end_at_utc
      : acceptProposedEnd && typeof fields.proposed_end_at_utc === "string"
        ? fields.proposed_end_at_utc
        : undefined;
    if (end !== undefined) body.end_at_utc = end;
    body.start_date = null;
    body.end_date_exclusive = null;
  }

  if (mode === "create") {
    const notes = nullableString(fields.notes);
    const location = nullableString(fields.location);
    if (notes !== undefined) body.notes = notes;
    if (location !== undefined) body.location = location;
  }
  return body;
}

export function proposedEventEndLabel(fields: Record<string, unknown>): string | null {
  return typeof fields.proposed_end_local === "string" ? fields.proposed_end_local : null;
}
