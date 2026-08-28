import type {
  CoffeeDiaryBean,
  CoffeeDiaryBeanDetail,
  CoffeeDiaryCollection,
  CoffeeDiaryExport,
  CoffeeDiaryExtraction,
  CoffeeDiaryRecipe,
  CoffeeDiaryRecipeField
} from "@artem/contracts";

export class CoffeeDiaryApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = "CoffeeDiaryApiError";
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${label}`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) throw new Error(`invalid_${label}`);
}

function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string" || value.length > max || /\p{C}/u.test(value) || value.includes("<") || value.includes(">")) throw new Error(`invalid_${label}`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`invalid_${label}`);
  return normalized;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === null) return null;
  return text(value, label, max, false) || null;
}

function timestamp(value: unknown, label: string): string {
  const candidate = text(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(candidate) || !Number.isFinite(Date.parse(candidate))) throw new Error(`invalid_${label}`);
  return candidate;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`invalid_${label}`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid_${label}`);
  return value;
}

export function parseCoffeeDiaryRecipe(value: unknown): CoffeeDiaryRecipe {
  const raw = object(value, "recipe");
  exactKeys(raw, ["method", "fields"], "recipe");
  if (!Array.isArray(raw.fields) || raw.fields.length > 24) throw new Error("invalid_recipe_fields");
  const fields = raw.fields.map((candidate) => {
    const field = object(candidate, "recipe_field");
    exactKeys(field, ["key", "label", "kind", "value", "unit"], "recipe_field");
    const kind = field.kind === "text" || field.kind === "number" ? field.kind : null;
    if (!kind) throw new Error("invalid_recipe_field_kind");
    const parsedValue = kind === "number"
      ? typeof field.value === "number" && Number.isFinite(field.value) ? field.value : null
      : typeof field.value === "string" ? text(field.value, "recipe_field_value", 160) : null;
    if (parsedValue === null) throw new Error("invalid_recipe_field_value");
    return {
      key: text(field.key, "recipe_field_key", 32),
      label: text(field.label, "recipe_field_label", 64),
      kind,
      value: parsedValue,
      unit: optionalText(field.unit, "recipe_field_unit", 16)
    } satisfies CoffeeDiaryRecipeField;
  });
  const keys = fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) throw new Error("invalid_recipe_duplicate_key");
  return { method: text(raw.method, "recipe_method", 64), fields };
}

function parseBean(value: unknown): CoffeeDiaryBean {
  const raw = object(value, "bean");
  exactKeys(raw, ["id", "version", "name", "roaster", "roastDate", "roastLevel", "roastNotes", "origin", "processing", "notes", "defaultRecipe", "createdAt", "updatedAt", "deletedAt"], "bean");
  return {
    id: uuid(raw.id, "bean_id"),
    version: integer(raw.version, "bean_version", 1, 2_147_483_647),
    name: text(raw.name, "bean_name", 96),
    roaster: optionalText(raw.roaster, "bean_roaster", 96),
    roastDate: raw.roastDate === null ? null : text(raw.roastDate, "bean_roast_date", 10),
    roastLevel: optionalText(raw.roastLevel, "bean_roast_level", 64),
    roastNotes: optionalText(raw.roastNotes, "bean_roast_notes", 240),
    origin: optionalText(raw.origin, "bean_origin", 96),
    processing: optionalText(raw.processing, "bean_processing", 96),
    notes: optionalText(raw.notes, "bean_notes", 2_000),
    defaultRecipe: raw.defaultRecipe === null ? null : parseCoffeeDiaryRecipe(raw.defaultRecipe),
    createdAt: timestamp(raw.createdAt, "bean_created_at"),
    updatedAt: timestamp(raw.updatedAt, "bean_updated_at"),
    deletedAt: raw.deletedAt === null ? null : timestamp(raw.deletedAt, "bean_deleted_at")
  };
}

function parseExtraction(value: unknown): CoffeeDiaryExtraction {
  const raw = object(value, "extraction");
  exactKeys(raw, ["id", "version", "beanId", "brewedAt", "method", "recipeSnapshot", "notes", "rating", "createdAt", "updatedAt", "deletedAt"], "extraction");
  const rating = raw.rating === null ? null : integer(raw.rating, "extraction_rating", 1, 10);
  const recipeSnapshot = parseCoffeeDiaryRecipe(raw.recipeSnapshot);
  const method = text(raw.method, "extraction_method", 64);
  if (method !== recipeSnapshot.method) throw new Error("invalid_extraction_method");
  return {
    id: uuid(raw.id, "extraction_id"),
    version: integer(raw.version, "extraction_version", 1, 2_147_483_647),
    beanId: uuid(raw.beanId, "extraction_bean_id"),
    brewedAt: timestamp(raw.brewedAt, "extraction_brewed_at"),
    method,
    recipeSnapshot,
    notes: optionalText(raw.notes, "extraction_notes", 4_000),
    rating,
    createdAt: timestamp(raw.createdAt, "extraction_created_at"),
    updatedAt: timestamp(raw.updatedAt, "extraction_updated_at"),
    deletedAt: raw.deletedAt === null ? null : timestamp(raw.deletedAt, "extraction_deleted_at")
  };
}

export function parseCoffeeDiaryCollection(value: unknown): CoffeeDiaryCollection {
  const raw = object(value, "collection");
  exactKeys(raw, ["schemaVersion", "revision", "updatedAt", "beans", "recentExtractions", "beanCount", "extractionCount"], "collection");
  if (raw.schemaVersion !== "coffee.diary.v1" || !Array.isArray(raw.beans) || raw.beans.length > 200 || !Array.isArray(raw.recentExtractions) || raw.recentExtractions.length > 200) throw new Error("invalid_coffee_diary_collection");
  return {
    schemaVersion: "coffee.diary.v1",
    revision: integer(raw.revision, "revision", 0, 2_147_483_647),
    updatedAt: timestamp(raw.updatedAt, "updated_at"),
    beans: raw.beans.map(parseBean),
    recentExtractions: raw.recentExtractions.map(parseExtraction),
    beanCount: integer(raw.beanCount, "bean_count", 0, 2_147_483_647),
    extractionCount: integer(raw.extractionCount, "extraction_count", 0, 2_147_483_647)
  };
}

export function parseCoffeeDiaryBean(value: unknown): CoffeeDiaryBean {
  return parseBean(value);
}

export function parseCoffeeDiaryBeanDetail(value: unknown): CoffeeDiaryBeanDetail {
  const raw = object(value, "bean_detail");
  exactKeys(raw, ["bean", "extractions"], "bean_detail");
  if (!Array.isArray(raw.extractions) || raw.extractions.length > 200) throw new Error("invalid_extractions");
  return { bean: parseBean(raw.bean), extractions: raw.extractions.map(parseExtraction) };
}

export function parseCoffeeDiaryExport(value: unknown): CoffeeDiaryExport {
  const raw = object(value, "export");
  exactKeys(raw, ["schemaVersion", "sourceSchemaVersion", "revision", "updatedAt", "beans", "extractions"], "export");
  if (raw.schemaVersion !== "coffee.diary.export.v1" || raw.sourceSchemaVersion !== "coffee.diary.v1" || !Array.isArray(raw.beans) || raw.beans.length > 500 || !Array.isArray(raw.extractions) || raw.extractions.length > 5_000) throw new Error("invalid_coffee_diary_export");
  return {
    schemaVersion: "coffee.diary.export.v1",
    sourceSchemaVersion: "coffee.diary.v1",
    revision: integer(raw.revision, "revision", 0, 2_147_483_647),
    updatedAt: timestamp(raw.updatedAt, "updated_at"),
    beans: raw.beans.map(parseBean),
    extractions: raw.extractions.map(parseExtraction)
  };
}

async function requestJson<T>(path: string, parser: (value: unknown) => T, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json", ...init?.headers }
    });
  } catch {
    throw new CoffeeDiaryApiError(0, "network");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string"
      ? (body as { detail: string }).detail
      : `http_${response.status}`;
    throw new CoffeeDiaryApiError(response.status, code);
  }
  try {
    return parser(body);
  } catch {
    throw new CoffeeDiaryApiError(response.status, "contract");
  }
}

const mutationHeaders = (key: string): HeadersInit => ({ "Idempotency-Key": key });

export function getCoffeeDiary(): Promise<CoffeeDiaryCollection> {
  return requestJson("/api/v1/coffee-diary", parseCoffeeDiaryCollection);
}

export function getCoffeeDiaryBean(beanId: string): Promise<CoffeeDiaryBeanDetail> {
  return requestJson(`/api/v1/coffee-diary/beans/${encodeURIComponent(beanId)}`, parseCoffeeDiaryBeanDetail);
}

export function createCoffeeDiaryBean(payload: Record<string, unknown>, idempotencyKey: string): Promise<CoffeeDiaryBean> {
  return requestJson("/api/v1/coffee-diary/beans", parseCoffeeDiaryBean, { method: "POST", headers: mutationHeaders(idempotencyKey), body: JSON.stringify(payload) });
}

export function patchCoffeeDiaryBean(beanId: string, version: number, payload: Record<string, unknown>): Promise<CoffeeDiaryBean> {
  return requestJson(`/api/v1/coffee-diary/beans/${encodeURIComponent(beanId)}`, parseCoffeeDiaryBean, { method: "PATCH", headers: { "If-Match": `"${version}"` }, body: JSON.stringify(payload) });
}

export function deleteCoffeeDiaryBean(beanId: string, version: number): Promise<CoffeeDiaryBean> {
  return requestJson(`/api/v1/coffee-diary/beans/${encodeURIComponent(beanId)}`, parseCoffeeDiaryBean, { method: "DELETE", headers: { "If-Match": `"${version}"` } });
}

export function createCoffeeDiaryExtraction(beanId: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<CoffeeDiaryExtraction> {
  return requestJson(`/api/v1/coffee-diary/beans/${encodeURIComponent(beanId)}/extractions`, parseExtraction, { method: "POST", headers: mutationHeaders(idempotencyKey), body: JSON.stringify(payload) });
}

export function deleteCoffeeDiaryExtraction(extractionId: string, version: number): Promise<CoffeeDiaryExtraction> {
  return requestJson(`/api/v1/coffee-diary/extractions/${encodeURIComponent(extractionId)}`, parseExtraction, { method: "DELETE", headers: { "If-Match": `"${version}"` } });
}

export function getCoffeeDiaryExport(): Promise<CoffeeDiaryExport> {
  return requestJson("/api/v1/coffee-diary/export", parseCoffeeDiaryExport);
}
