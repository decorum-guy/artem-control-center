import type { InterfaceCopyCatalog, InterfaceCopyField, InterfaceCopyOverrides, InterfaceCopySettings } from "@artem/contracts";

export class InterfaceCopyApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = "InterfaceCopyApiError";
  }
}

type JsonObject = { [key: string]: unknown };

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid_${label}`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) throw new Error(`invalid_${label}`);
}

function text(value: unknown, label: string, max: number, required: boolean): string {
  if (typeof value !== "string" || value.length > max || /\p{C}/u.test(value) || value.includes("<") || value.includes(">")) throw new Error(`invalid_${label}`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`invalid_${label}`);
  return normalized;
}

function catalog(value: unknown): InterfaceCopyCatalog {
  const raw = object(value, "catalog");
  exactKeys(raw, ["navigation", "navigationGroup", "page"], "catalog");
  const nav = object(raw.navigation, "navigation");
  const navKeys = ["overview", "weather", "home", "services", "calendar", "tasks", "reminders", "coffeeDiary", "backups", "apps", "system", "settings"] as const;
  exactKeys(nav, navKeys, "navigation");
  const navigation = Object.fromEntries(navKeys.map((key) => [key, text(nav[key], `navigation_${key}`, 48, true)])) as InterfaceCopyCatalog["navigation"];
  const group = object(raw.navigationGroup, "navigation_group");
  exactKeys(group, ["planning"], "navigation_group");
  const pageRaw = object(raw.page, "page");
  const pageKeys = ["overview", "weather", "home", "services", "calendar", "tasks", "reminders", "coffeeDiary", "backups", "apps", "system", "settings"] as const;
  exactKeys(pageRaw, pageKeys, "page");
  const page = Object.fromEntries(pageKeys.map((key) => {
    const value = object(pageRaw[key], `page_${key}`);
    exactKeys(value, ["title", "subtitle"], `page_${key}`);
    return [key, { title: text(value.title, `page_${key}_title`, 96, true), subtitle: text(value.subtitle, `page_${key}_subtitle`, 240, false) }];
  })) as InterfaceCopyCatalog["page"];
  return { navigation, navigationGroup: { planning: text(group.planning, "navigation_group_planning", 48, true) }, page };
}

function optional(value: unknown, label: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null) return null;
  return text(value, label, max, required);
}

function overrides(value: unknown): InterfaceCopyOverrides {
  const raw = object(value, "overrides");
  exactKeys(raw, ["navigation", "navigationGroup", "page"], "overrides");
  const nav = object(raw.navigation, "navigation_overrides");
  const navKeys = ["overview", "weather", "home", "services", "calendar", "tasks", "reminders", "coffeeDiary", "backups", "apps", "system", "settings"] as const;
  if (Object.keys(nav).some((key) => !navKeys.includes(key as typeof navKeys[number]))) throw new Error("invalid_navigation_overrides");
  const navigation = Object.fromEntries(navKeys.map((key) => [key, optional(nav[key], `navigation_${key}`, 48, true)]).filter(([, value]) => value !== null)) as InterfaceCopyOverrides["navigation"];
  const group = object(raw.navigationGroup, "navigation_group_overrides");
  if (Object.keys(group).some((key) => key !== "planning")) throw new Error("invalid_navigation_group_overrides");
  const navigationGroup = optional(group.planning, "navigation_group_planning", 48, true) === null ? {} : { planning: optional(group.planning, "navigation_group_planning", 48, true) };
  const pageRaw = object(raw.page, "page_overrides");
  const pageKeys = ["overview", "weather", "home", "services", "calendar", "tasks", "reminders", "coffeeDiary", "backups", "apps", "system", "settings"] as const;
  const actualPageKeys = Object.keys(pageRaw).sort();
  const fullPageKeys = [...pageKeys].sort();
  const legacyPageKeys = pageKeys.filter((key) => key !== "coffeeDiary").sort();
  if (![fullPageKeys, legacyPageKeys].some((keys) => keys.length === actualPageKeys.length && keys.every((key, index) => key === actualPageKeys[index]))) throw new Error("invalid_page_overrides");
  const page = Object.fromEntries(pageKeys.map((key) => {
    const pageValue = object(pageRaw[key] ?? {}, `page_${key}_overrides`);
    if (Object.keys(pageValue).some((entry) => entry !== "title" && entry !== "subtitle")) throw new Error(`invalid_page_${key}_overrides`);
    const result = {
      ...(pageValue.title === undefined || pageValue.title === null ? {} : { title: optional(pageValue.title, `page_${key}_title`, 96, true) as string }),
      ...(pageValue.subtitle === undefined || pageValue.subtitle === null ? {} : { subtitle: optional(pageValue.subtitle, `page_${key}_subtitle`, 240, false) as string })
    };
    return [key, result];
  })) as InterfaceCopyOverrides["page"];
  return { navigation, navigationGroup, page };
}

export function parseInterfaceCopy(value: unknown): InterfaceCopySettings {
  const raw = object(value, "interface_copy");
  exactKeys(raw, ["schemaVersion", "revision", "recoveryRevision", "updatedAt", "defaults", "overrides", "effective", "available", "warnings", "writesEnabled"], "interface_copy");
  if (raw.schemaVersion !== "interface.copy-settings.v1" || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || (raw.recoveryRevision !== null && (!Number.isSafeInteger(raw.recoveryRevision) || (raw.recoveryRevision as number) < 0)) || typeof raw.updatedAt !== "string" || typeof raw.available !== "boolean" || typeof raw.writesEnabled !== "boolean" || !Array.isArray(raw.warnings) || (raw.available && raw.recoveryRevision !== null) || (!raw.available && raw.recoveryRevision !== 0)) throw new Error("invalid_interface_copy");
  if (!raw.warnings.every((warning) => warning === "stored_copy_settings_unavailable")) throw new Error("invalid_interface_copy_warnings");
  const defaults = catalog(raw.defaults);
  const parsedOverrides = overrides(raw.overrides);
  const effective = catalog(raw.effective);
  return {
    schemaVersion: "interface.copy-settings.v1",
    revision: raw.revision as number,
    recoveryRevision: raw.recoveryRevision as number | null,
    updatedAt: raw.updatedAt as string,
    defaults,
    overrides: parsedOverrides,
    effective,
    available: raw.available as boolean,
    warnings: raw.warnings as ("stored_copy_settings_unavailable")[],
    writesEnabled: raw.writesEnabled as boolean
  };
}

async function request(path: string, init?: RequestInit): Promise<InterfaceCopySettings> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", ...init?.headers } });
  } catch {
    throw new InterfaceCopyApiError(0, "network");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string" ? (body as { detail: string }).detail : `http_${response.status}`;
    throw new InterfaceCopyApiError(response.status, code);
  }
  try {
    return parseInterfaceCopy(body);
  } catch {
    throw new InterfaceCopyApiError(response.status, "contract");
  }
}

export function getInterfaceCopy(): Promise<InterfaceCopySettings> {
  return request("/api/v1/settings/interface-copy");
}

export function patchInterfaceCopy(payload: { expectedRevision: number; field?: InterfaceCopyField; value?: string | null; resetAll?: boolean }): Promise<InterfaceCopySettings> {
  return request("/api/v1/settings/interface-copy", { method: "PATCH", body: JSON.stringify(payload) });
}
