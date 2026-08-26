/**
 * The single maintained frontend profile used by the Windows production build.
 *
 * The source gates stay explicit so fixture/e2e jobs can still exercise both
 * sides of each rollout seam. Production is deterministic: the guarded
 * updater invokes build:production, which applies this complete profile and
 * does not depend on a Samsung-local VITE environment.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const productionBuildProfile = Object.freeze({
  VITE_V2_VISUAL_SHELL: "true",
  VITE_OVERVIEW_V2_ENABLED: "true",
  VITE_OVERVIEW_EDITOR_ENABLED: "true",
  VITE_PLANNING_OVERVIEW_ENABLED: "true",
  VITE_PLANNING_TASKS_ROUTE_ENABLED: "true",
  VITE_PLANNING_CALENDAR_ROUTE_ENABLED: "true",
  VITE_PLANNING_REMINDERS_ROUTE_ENABLED: "true",
  VITE_PLANNING_REMINDER_MUTATIONS_ENABLED: "true",
  VITE_PLANNING_TASK_MUTATIONS_ENABLED: "true",
  VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED: "true",
  VITE_TOUCH_INPUT_LOCK_ENABLED: "true",
  VITE_TOUCH_INPUT_LOCK_START_LOCKED: "true"
});

export const productionBuildProfileName = "accepted-v2";

export const PERSISTED_CAPABILITY_IDS = Object.freeze([
  "calendar_display_colors",
  "overview_layout_editor",
  "planning_overview",
  "planning_tasks_route",
  "planning_calendar_route",
  "planning_reminders_route"
]);

export const MAX_CAPABILITY_OVERRIDE_FILE_BYTES = 16 * 1024;

/** Resolve the Panel-owned durable store without reading a developer file. */
export function resolveCapabilityOverridesPath(environment = process.env) {
  const explicit = environment.PANEL_CAPABILITY_OVERRIDES_PATH?.trim();
  if (explicit) return explicit;
  const localAppData = environment.LOCALAPPDATA?.trim();
  return localAppData ? join(localAppData, "ArtemControlCenter", "capability-overrides.json") : null;
}

export const delayedBuildCapabilityVariables = Object.freeze({
  planning_overview: "VITE_PLANNING_OVERVIEW_ENABLED",
  planning_tasks_route: "VITE_PLANNING_TASKS_ROUTE_ENABLED",
  planning_calendar_route: "VITE_PLANNING_CALENDAR_ROUTE_ENABLED",
  planning_reminders_route: "VITE_PLANNING_REMINDERS_ROUTE_ENABLED"
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isCanonicalCapabilityOverrideDocument(value) {
  if (
    !isPlainObject(value)
    || value.schemaVersion !== "capability-overrides.v1"
    || !Number.isInteger(value.revision)
    || value.revision < 0
    || typeof value.updatedAt !== "string"
    || !isPlainObject(value.overrides)
  ) {
    return false;
  }
  return Object.keys(value.overrides).every(
    (id) => PERSISTED_CAPABILITY_IDS.includes(id) && typeof value.overrides[id] === "boolean"
  );
}

export function safeDelayedCapabilityOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides)
    ? value.overrides
    : value;
  return Object.fromEntries(
    Object.keys(delayedBuildCapabilityVariables)
      .filter((key) => typeof raw[key] === "boolean")
      .map((key) => [key, raw[key]])
  );
}

/**
 * Read only the canonical Panel-owned store selected by the production build.
 * A missing store is the accepted baseline; a malformed present store fails
 * closed instead of silently rebuilding a different bundle.
 */
export function loadProductionCapabilityOverrides(environment = process.env) {
  const path = resolveCapabilityOverridesPath(environment);
  if (!path || !existsSync(path)) return {};
  try {
    if (statSync(path).size > MAX_CAPABILITY_OVERRIDE_FILE_BYTES) {
      throw new Error("capability_store_too_large");
    }
    const document = JSON.parse(readFileSync(path, "utf8"));
    if (!isCanonicalCapabilityOverrideDocument(document)) {
      throw new Error("invalid_document");
    }
    return safeDelayedCapabilityOverrides(document.overrides);
  } catch {
    throw new Error("Capability override store is invalid; refusing production build");
  }
}

export function productionBuildCapabilities(overrides = {}) {
  const safe = safeDelayedCapabilityOverrides(overrides);
  const baseline = Object.fromEntries(
    Object.entries(delayedBuildCapabilityVariables).map(([id, variable]) => [id, productionBuildProfile[variable] === "true"])
  );
  return {
    baseline,
    active: { ...baseline, ...safe },
    flags: Object.fromEntries(
      Object.entries(productionBuildProfile).map(([name, value]) => [name, value === "true"])
    )
  };
}

export function productionBuildEnvironment(baseEnvironment = process.env, overrides = {}) {
  const capabilities = productionBuildCapabilities(overrides);
  return {
    ...baseEnvironment,
    ...productionBuildProfile,
    ...Object.fromEntries(
      Object.entries(delayedBuildCapabilityVariables).map(([id, variable]) => [variable, String(capabilities.active[id])])
    )
  };
}
