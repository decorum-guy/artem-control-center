import type { OverviewLayoutDocument, OverviewLayoutItem } from "@artem/contracts";
import { makeShippedOverviewDocument, normalizeOverviewDocument } from "./overviewEditorReducer";

export class OverviewLayoutApiError extends Error {
  readonly status: number;
  readonly uncertain: boolean;
  readonly conflict: boolean;

  constructor(message: string, status = 0, options: { uncertain?: boolean; conflict?: boolean } = {}) {
    super(message);
    this.name = "OverviewLayoutApiError";
    this.status = status;
    this.uncertain = options.uncertain ?? false;
    this.conflict = options.conflict ?? false;
  }
}

export interface OverviewLayoutReadResult {
  readonly document: OverviewLayoutDocument;
  readonly etag: string;
  readonly available: boolean;
}

const OVERVIEW_SAVE_TIMEOUT_MS = 8_000;

function saveSignal(parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), OVERVIEW_SAVE_TIMEOUT_MS);
  const abortFromParent = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    parent.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      window.clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    }
  };
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function documentFromPayload(payload: Record<string, unknown>, writesEnabled: boolean): OverviewLayoutDocument {
  return normalizeOverviewDocument({
    schemaVersion: payload.schemaVersion as OverviewLayoutDocument["schemaVersion"],
    profileId: payload.profileId as OverviewLayoutDocument["profileId"],
    presetId: payload.presetId as OverviewLayoutDocument["presetId"],
    presetVersion: payload.presetVersion as OverviewLayoutDocument["presetVersion"],
    revision: payload.revision as number,
    viewportClass: payload.viewportClass as OverviewLayoutDocument["viewportClass"],
    updatedAt: payload.updatedAt as string,
    items: Array.isArray(payload.items) ? payload.items as OverviewLayoutItem[] : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings.filter((entry): entry is string => typeof entry === "string") : [],
    unplaced: Array.isArray(payload.unplaced) ? payload.unplaced as OverviewLayoutDocument["unplaced"] : [],
    writesEnabled: typeof payload.writesEnabled === "boolean" ? payload.writesEnabled : writesEnabled
  }, writesEnabled);
}

export async function getOverviewLayout(signal?: AbortSignal): Promise<OverviewLayoutReadResult> {
  try {
    const response = await fetch("/api/v1/overview/layout", {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal
    });
    const payload = parseJson(await response.text());
    if (!response.ok || !payload) {
      throw new OverviewLayoutApiError("Панель не вернула сохранённую конфигурацию.", response.status);
    }
    const writesEnabled = payload.writesEnabled === true || response.headers.get("X-Overview-Layout-Writes-Enabled") === "true";
    const document = documentFromPayload(payload, writesEnabled);
    return { document, etag: response.headers.get("ETag") ?? `"${document.revision}"`, available: true };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof OverviewLayoutApiError && error.status !== 0) throw error;
    return {
      document: makeShippedOverviewDocument(false),
      etag: '"0"',
      available: false
    };
  }
}

export async function saveOverviewLayout(
  items: readonly OverviewLayoutItem[],
  expectedEtag: string,
  signal?: AbortSignal
): Promise<OverviewLayoutReadResult> {
  const timeoutSignal = saveSignal(signal);
  let response: Response;
  try {
    response = await fetch("/api/v1/overview/layout", {
      method: "PATCH",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "If-Match": expectedEtag
      },
      body: JSON.stringify({ items }),
      signal: timeoutSignal.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new OverviewLayoutApiError("Результат сохранения пока неизвестен.", 0, { uncertain: true });
    }
    throw new OverviewLayoutApiError("Результат сохранения пока неизвестен.", 0, { uncertain: true });
  } finally {
    timeoutSignal.dispose();
  }
  const payload = parseJson(await response.text());
  if (response.status === 409 || response.status === 412) {
    throw new OverviewLayoutApiError("Панель изменилась в другом окне.", response.status, { conflict: true });
  }
  if (!response.ok || !payload) {
    throw new OverviewLayoutApiError("Сервер отклонил конфигурацию панели.", response.status);
  }
  const document = documentFromPayload(payload, payload.writesEnabled === true);
  return { document, etag: response.headers.get("ETag") ?? `"${document.revision}"`, available: true };
}

export async function readBackOverviewLayout(signal?: AbortSignal): Promise<OverviewLayoutReadResult> {
  try {
    return await getOverviewLayout(signal);
  } catch (error) {
    if (error instanceof OverviewLayoutApiError) {
      throw new OverviewLayoutApiError("Не удалось подтвердить состояние сохранённой панели.", error.status, { uncertain: true });
    }
    throw new OverviewLayoutApiError("Не удалось подтвердить состояние сохранённой панели.", 0, { uncertain: true });
  }
}
