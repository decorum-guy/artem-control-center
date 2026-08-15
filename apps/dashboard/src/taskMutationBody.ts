import type { PlanningTask } from "@artem/contracts";

export type TaskMutationSheetMode = "create" | "edit";

export type TaskMutationBody = {
  title?: string;
  notes?: string | null;
  due_date?: string | null;
  due_time?: string | null;
  timezone?: string | null;
  priority?: PlanningTask["priority"];
  project_id?: string | null;
};

const priorityValues = new Set<PlanningTask["priority"]>(["none", "low", "normal", "high"]);

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

type NullableTaskMutationField = "notes" | "due_date" | "due_time" | "timezone" | "project_id";

function addNullableString(body: TaskMutationBody, field: NullableTaskMutationField, value: unknown): void {
  const normalized = nullableString(value);
  if (normalized !== undefined) body[field] = normalized;
}

/** Build only the fields owned by the parser-driven task workflow for this mutation mode. */
export function taskMutationBodyFromPreview(
  mode: TaskMutationSheetMode,
  fields: Record<string, unknown>
): TaskMutationBody {
  const body: TaskMutationBody = {};
  if (typeof fields.title === "string") body.title = fields.title;
  addNullableString(body, "due_date", fields.due_date);
  addNullableString(body, "due_time", fields.due_time);
  addNullableString(body, "timezone", fields.timezone);

  if (mode === "create") {
    if (typeof fields.priority === "string" && priorityValues.has(fields.priority as PlanningTask["priority"])) {
      body.priority = fields.priority as PlanningTask["priority"];
    }
    addNullableString(body, "notes", fields.notes);
    addNullableString(body, "project_id", fields.project_id);
  }

  return body;
}
