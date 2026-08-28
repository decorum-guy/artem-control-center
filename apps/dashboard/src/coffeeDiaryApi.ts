import type {
  CoffeeDiaryBean,
  CoffeeDiaryBeanDetail,
  CoffeeDiaryCollection,
  CoffeeDiaryExport,
  CoffeeDiaryExtraction,
  CoffeeDiaryPhotoUploadResult,
  CoffeeDiaryPhoto,
  CoffeeDiaryPreferredDrink,
  CoffeeDiaryUploadSession
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

function grams(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000 || !/^\d+(?:\.\d)?$/.test(String(value))) throw new Error(`invalid_${label}`);
  return value;
}

function preferredDrink(value: unknown): CoffeeDiaryPreferredDrink | null {
  if (value === null) return null;
  if (value === "espresso" || value === "milk" || value === "universal") return value;
  throw new Error("invalid_preferred_drink");
}

export function parseCoffeeDiaryPhoto(value: unknown): CoffeeDiaryPhoto {
  const raw = object(value, "photo");
  exactKeys(raw, ["id", "beanId", "storageId", "mediaType", "byteSize", "width", "height", "sha256", "createdAt", "deletedAt"], "photo");
  if (typeof raw.storageId !== "string" || raw.storageId.length > 128 || /[/\\]/.test(raw.storageId)) throw new Error("invalid_photo_storage_id");
  if (typeof raw.mediaType !== "string" || !/^image\/[a-z0-9.+-]+$/.test(raw.mediaType)) throw new Error("invalid_photo_media_type");
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) throw new Error("invalid_photo_sha256");
  return {
    id: uuid(raw.id, "photo_id"),
    beanId: uuid(raw.beanId, "photo_bean_id"),
    storageId: text(raw.storageId, "photo_storage_id", 128),
    mediaType: text(raw.mediaType, "photo_media_type", 64),
    byteSize: integer(raw.byteSize, "photo_byte_size", 1, 25 * 1024 * 1024),
    width: integer(raw.width, "photo_width", 1, 20_000),
    height: integer(raw.height, "photo_height", 1, 20_000),
    sha256: text(raw.sha256, "photo_sha256", 64),
    createdAt: timestamp(raw.createdAt, "photo_created_at"),
    deletedAt: raw.deletedAt === null ? null : timestamp(raw.deletedAt, "photo_deleted_at")
  };
}

function parseBean(value: unknown): CoffeeDiaryBean {
  const raw = object(value, "bean");
  exactKeys(raw, ["id", "version", "name", "grindDescription", "preferredDrink", "roaster", "roastDate", "roastLevel", "roastNotes", "origin", "processing", "notes", "favoriteExtractionId", "photoIds", "createdAt", "updatedAt", "deletedAt"], "bean");
  if (!Array.isArray(raw.photoIds) || raw.photoIds.length > 24) throw new Error("invalid_bean_photo_ids");
  return {
    id: uuid(raw.id, "bean_id"),
    version: integer(raw.version, "bean_version", 1, 2_147_483_647),
    name: text(raw.name, "bean_name", 96),
    grindDescription: optionalText(raw.grindDescription, "bean_grind_description", 240),
    preferredDrink: preferredDrink(raw.preferredDrink),
    roaster: optionalText(raw.roaster, "bean_roaster", 96),
    roastDate: raw.roastDate === null ? null : text(raw.roastDate, "bean_roast_date", 10),
    roastLevel: optionalText(raw.roastLevel, "bean_roast_level", 64),
    roastNotes: optionalText(raw.roastNotes, "bean_roast_notes", 240),
    origin: optionalText(raw.origin, "bean_origin", 96),
    processing: optionalText(raw.processing, "bean_processing", 96),
    notes: optionalText(raw.notes, "bean_notes", 2_000),
    favoriteExtractionId: raw.favoriteExtractionId === null ? null : uuid(raw.favoriteExtractionId, "favorite_extraction_id"),
    photoIds: raw.photoIds.map((photoId) => uuid(photoId, "bean_photo_id")),
    createdAt: timestamp(raw.createdAt, "bean_created_at"),
    updatedAt: timestamp(raw.updatedAt, "bean_updated_at"),
    deletedAt: raw.deletedAt === null ? null : timestamp(raw.deletedAt, "bean_deleted_at")
  };
}

export function parseCoffeeDiaryExtraction(value: unknown): CoffeeDiaryExtraction {
  const raw = object(value, "extraction");
  exactKeys(raw, ["id", "version", "beanId", "brewedAt", "doseGrams", "extractionSeconds", "yieldGrams", "notes", "rating", "createdAt", "updatedAt", "deletedAt"], "extraction");
  const rating = raw.rating === null ? null : integer(raw.rating, "extraction_rating", 1, 10);
  return {
    id: uuid(raw.id, "extraction_id"),
    version: integer(raw.version, "extraction_version", 1, 2_147_483_647),
    beanId: uuid(raw.beanId, "extraction_bean_id"),
    brewedAt: timestamp(raw.brewedAt, "extraction_brewed_at"),
    doseGrams: grams(raw.doseGrams, "extraction_dose_grams"),
    extractionSeconds: integer(raw.extractionSeconds, "extraction_seconds", 1, 3_600),
    yieldGrams: grams(raw.yieldGrams, "extraction_yield_grams"),
    notes: optionalText(raw.notes, "extraction_notes", 4_000),
    rating,
    createdAt: timestamp(raw.createdAt, "extraction_created_at"),
    updatedAt: timestamp(raw.updatedAt, "extraction_updated_at"),
    deletedAt: raw.deletedAt === null ? null : timestamp(raw.deletedAt, "extraction_deleted_at")
  };
}

export function parseCoffeeDiaryCollection(value: unknown): CoffeeDiaryCollection {
  const raw = object(value, "collection");
  exactKeys(raw, ["schemaVersion", "revision", "updatedAt", "beans", "recentExtractions", "photos", "beanCount", "extractionCount"], "collection");
  if (raw.schemaVersion !== "coffee.diary.v1" || !Array.isArray(raw.beans) || raw.beans.length > 200 || !Array.isArray(raw.recentExtractions) || raw.recentExtractions.length > 200 || !Array.isArray(raw.photos) || raw.photos.length > 2_000) throw new Error("invalid_coffee_diary_collection");
  return {
    schemaVersion: "coffee.diary.v1",
    revision: integer(raw.revision, "revision", 0, 2_147_483_647),
    updatedAt: timestamp(raw.updatedAt, "updated_at"),
    beans: raw.beans.map(parseBean),
    recentExtractions: raw.recentExtractions.map(parseCoffeeDiaryExtraction),
    photos: raw.photos.map(parseCoffeeDiaryPhoto),
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
  return { bean: parseBean(raw.bean), extractions: raw.extractions.map(parseCoffeeDiaryExtraction) };
}

export function parseCoffeeDiaryExport(value: unknown): CoffeeDiaryExport {
  const raw = object(value, "export");
  exactKeys(raw, ["schemaVersion", "sourceSchemaVersion", "revision", "updatedAt", "beans", "extractions", "photos"], "export");
  if (raw.schemaVersion !== "coffee.diary.export.v1" || raw.sourceSchemaVersion !== "coffee.diary.v1" || !Array.isArray(raw.beans) || raw.beans.length > 500 || !Array.isArray(raw.extractions) || raw.extractions.length > 5_000 || !Array.isArray(raw.photos) || raw.photos.length > 2_000) throw new Error("invalid_coffee_diary_export");
  return {
    schemaVersion: "coffee.diary.export.v1",
    sourceSchemaVersion: "coffee.diary.v1",
    revision: integer(raw.revision, "revision", 0, 2_147_483_647),
    updatedAt: timestamp(raw.updatedAt, "updated_at"),
    beans: raw.beans.map(parseBean),
    extractions: raw.extractions.map(parseCoffeeDiaryExtraction),
    photos: raw.photos.map(parseCoffeeDiaryPhoto)
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

export function patchCoffeeDiaryFavorite(beanId: string, version: number, extractionId: string | null): Promise<CoffeeDiaryBean> {
  return requestJson(`/api/v1/coffee-diary/beans/${encodeURIComponent(beanId)}/favorite-extraction`, parseCoffeeDiaryBean, { method: "PATCH", headers: { "If-Match": `"${version}"` }, body: JSON.stringify({ extractionId }) });
}

export function deleteCoffeeDiaryBean(beanId: string, version: number): Promise<CoffeeDiaryBean> {
  return requestJson(`/api/v1/coffee-diary/beans/${encodeURIComponent(beanId)}`, parseCoffeeDiaryBean, { method: "DELETE", headers: { "If-Match": `"${version}"` } });
}

export function createCoffeeDiaryExtraction(beanId: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<CoffeeDiaryExtraction> {
  return requestJson(`/api/v1/coffee-diary/beans/${encodeURIComponent(beanId)}/extractions`, parseCoffeeDiaryExtraction, { method: "POST", headers: mutationHeaders(idempotencyKey), body: JSON.stringify(payload) });
}

export function deleteCoffeeDiaryExtraction(extractionId: string, version: number): Promise<CoffeeDiaryExtraction> {
  return requestJson(`/api/v1/coffee-diary/extractions/${encodeURIComponent(extractionId)}`, parseCoffeeDiaryExtraction, { method: "DELETE", headers: { "If-Match": `"${version}"` } });
}

export function getCoffeeDiaryExport(): Promise<CoffeeDiaryExport> {
  return requestJson("/api/v1/coffee-diary/export", parseCoffeeDiaryExport);
}

function parseUploadSession(value: unknown): CoffeeDiaryUploadSession {
  const raw = object(value, "upload_session");
  const hasUrl = Object.prototype.hasOwnProperty.call(raw, "uploadUrl");
  exactKeys(raw, hasUrl
    ? ["sessionId", "state", "expiresAt", "remainingSeconds", "uploadUrl", "pendingAttachmentId", "photoId"]
    : ["sessionId", "state", "expiresAt", "remainingSeconds", "pendingAttachmentId", "photoId"], "upload_session");
  if (typeof raw.sessionId !== "string" || typeof raw.expiresAt !== "string" || typeof raw.remainingSeconds !== "number" || !Number.isSafeInteger(raw.remainingSeconds) || raw.remainingSeconds < 0) throw new Error("invalid_upload_session");
  if (!(["created", "uploading", "uploaded", "consumed", "cancelled", "expired"] as const).includes(raw.state as CoffeeDiaryUploadSession["state"])) throw new Error("invalid_upload_session_state");
  if (raw.pendingAttachmentId !== null && typeof raw.pendingAttachmentId !== "string") throw new Error("invalid_pending_attachment");
  if (raw.photoId !== null && typeof raw.photoId !== "string") throw new Error("invalid_upload_photo");
  if (hasUrl && typeof raw.uploadUrl !== "string") throw new Error("invalid_upload_url");
  return {
    sessionId: raw.sessionId,
    state: raw.state as CoffeeDiaryUploadSession["state"],
    expiresAt: raw.expiresAt,
    remainingSeconds: raw.remainingSeconds,
    uploadUrl: hasUrl ? raw.uploadUrl as string : undefined,
    pendingAttachmentId: raw.pendingAttachmentId as string | null,
    photoId: raw.photoId as string | null
  };
}

function parsePhotoUploadResult(value: unknown): CoffeeDiaryPhotoUploadResult {
  const raw = object(value, "photo_upload");
  exactKeys(raw, ["state", "pendingAttachmentId", "photoId"], "photo_upload");
  if (raw.state !== "uploaded" && raw.state !== "consumed") throw new Error("invalid_photo_upload_state");
  if (raw.pendingAttachmentId !== null && typeof raw.pendingAttachmentId !== "string") throw new Error("invalid_pending_attachment");
  if (raw.photoId !== null && typeof raw.photoId !== "string") throw new Error("invalid_upload_photo");
  return {
    state: raw.state,
    pendingAttachmentId: raw.pendingAttachmentId as string | null,
    photoId: raw.photoId as string | null
  };
}

export function createCoffeeDiaryPhotoUploadSession(beanId: string): Promise<CoffeeDiaryUploadSession> {
  return requestJson(`/api/v1/coffee-diary/beans/${encodeURIComponent(beanId)}/photo-upload-sessions`, parseUploadSession, { method: "POST" });
}

export function createCoffeeDiaryBeanPhotoUploadSession(): Promise<CoffeeDiaryUploadSession> {
  return requestJson("/api/v1/coffee-diary/photo-upload-sessions", parseUploadSession, { method: "POST", body: JSON.stringify({ intent: "bean_create" }) });
}

export function getCoffeeDiaryPhotoUploadSession(sessionId: string): Promise<CoffeeDiaryUploadSession> {
  return requestJson(`/api/v1/coffee-diary/photo-upload-sessions/${encodeURIComponent(sessionId)}`, parseUploadSession);
}

export function cancelCoffeeDiaryPhotoUploadSession(sessionId: string): Promise<CoffeeDiaryUploadSession> {
  return requestJson(`/api/v1/coffee-diary/photo-upload-sessions/${encodeURIComponent(sessionId)}`, parseUploadSession, { method: "DELETE" });
}

export async function discardCoffeeDiaryPendingPhoto(pendingId: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/coffee-diary/pending-photo-attachments/${encodeURIComponent(pendingId)}`, { method: "DELETE", cache: "no-store" });
  } catch {
    throw new CoffeeDiaryApiError(0, "network");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null;
    throw new CoffeeDiaryApiError(response.status, typeof body?.detail === "string" ? body.detail : `http_${response.status}`);
  }
}

export async function uploadCoffeeDiaryPhoto(token: string, file: File): Promise<CoffeeDiaryPhotoUploadResult> {
  let response: Response;
  try {
    response = await fetch("/api/v1/coffee-diary/photo-upload", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Coffee-Upload-Token": token, "Content-Type": file.type },
      body: file
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
    return parsePhotoUploadResult(body);
  } catch {
    throw new CoffeeDiaryApiError(response.status, "contract");
  }
}

export function coffeeDiaryPhotoContentUrl(photoId: string): string {
  return `/api/v1/coffee-diary/photos/${encodeURIComponent(photoId)}/content`;
}

export function coffeeDiaryPendingPhotoContentUrl(pendingId: string): string {
  return `/api/v1/coffee-diary/pending-photo-attachments/${encodeURIComponent(pendingId)}/content`;
}

export function downloadCoffeeDiaryCsv(): void {
  window.location.assign("/api/v1/coffee-diary/export.csv");
}

export function downloadCoffeeDiaryZip(): void {
  window.location.assign("/api/v1/coffee-diary/export.zip");
}
