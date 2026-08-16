import type { PlanningParsePreview } from "./planningReadClient";

export interface CalendarEventPreviewSaveState {
  canSave: boolean;
  isCanonicalStartOnlyProposal: boolean;
  hasMaterialAmbiguity: boolean;
}

const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && utcTimestampPattern.test(value) && Number.isFinite(Date.parse(value));
}

function validLocalDate(value: unknown): value is string {
  return typeof value === "string"
    && localDatePattern.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function validTimezone(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validTimedShape(fields: Record<string, unknown>, endField: "end_at_utc" | "proposed_end_at_utc"): boolean {
  if (fields.all_day !== false || !validTimezone(fields.timezone) || !validUtcTimestamp(fields.start_at_utc)) return false;
  if (!validUtcTimestamp(fields[endField])) return false;
  return Date.parse(fields[endField]) > Date.parse(fields.start_at_utc);
}

function validAllDayShape(fields: Record<string, unknown>): boolean {
  if (fields.all_day !== true || !validTimezone(fields.timezone)) return false;
  if (!validLocalDate(fields.start_date) || !validLocalDate(fields.end_date_exclusive)) return false;
  return Date.parse(`${fields.end_date_exclusive}T00:00:00Z`) > Date.parse(`${fields.start_date}T00:00:00Z`);
}

/**
 * Keep the Calendar save decision fail-closed while allowing only Alice's
 * canonical start-only +60-minute proposal to be explicitly acknowledged.
 */
export function calendarEventPreviewSaveState(
  preview: PlanningParsePreview | null | undefined,
  proposalAccepted: boolean
): CalendarEventPreviewSaveState {
  if (!preview || preview.error_code !== null || !preview.candidate || preview.candidate.domain !== "calendar_event" || preview.candidate.operation !== "create" || preview.confidence !== "high") {
    return { canSave: false, isCanonicalStartOnlyProposal: false, hasMaterialAmbiguity: Boolean(preview?.ambiguities.length) };
  }

  const fields = preview.candidate.fields;
  const hasEndTimeProposalAmbiguity = preview.ambiguities.some((ambiguity) => ambiguity.field === "end_time");
  const isCanonicalStartOnlyProposal = preview.requires_confirmation
    && hasEndTimeProposalAmbiguity
    && validTimedShape(fields, "proposed_end_at_utc")
    && (fields.end_at_utc === undefined || fields.end_at_utc === null);
  const hasMaterialAmbiguity = preview.ambiguities.length > 0
    && (!isCanonicalStartOnlyProposal
      || preview.ambiguities.length !== 1
      || preview.ambiguities[0]?.field !== "end_time");

  const directSave = !preview.requires_confirmation
    && preview.ambiguities.length === 0
    && nonEmptyString(fields.title)
    && (validTimedShape(fields, "end_at_utc") || validAllDayShape(fields));
  const proposalSave = isCanonicalStartOnlyProposal
    && !hasMaterialAmbiguity
    && nonEmptyString(fields.title)
    && proposalAccepted;

  return {
    canSave: directSave || proposalSave,
    isCanonicalStartOnlyProposal,
    hasMaterialAmbiguity
  };
}
