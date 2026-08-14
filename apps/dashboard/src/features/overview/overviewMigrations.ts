import type { OverviewLayoutItem, OverviewUnplacedWidget } from "@artem/contracts";
import { defaultAppearanceConfig, normalizeLayoutItems } from "./appearanceConfig";
import { getOverviewWidgetDefinition } from "./overviewRegistry";
import { makeShippedOverviewDocument } from "./overviewEditorReducer";

export interface ParsedOverviewLayout {
  readonly items: OverviewLayoutItem[];
  readonly warnings: string[];
  readonly unplaced: OverviewUnplacedWidget[];
  readonly usedFallback: boolean;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeId(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) ? value : fallback;
}

function legacyWidgetType(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  return ({
    "widget.coffee.primary": "home.coffee-machine",
    "widget.rog.primary": "system.rog-g703-operational",
    "widget.planning.summary": "planning.summary",
    "widget.quick-actions": "home.quick-actions",
    "widget.health": "system.health-summary"
  } as Record<string, string>)[value] ?? value;
}

/** Pure v1 -> v2 migration. It has no filesystem, network, or runtime hooks. */
export function migrateV1ToV2(raw: unknown): unknown {
  const root = objectRecord(raw);
  if (!root) return raw;
  const sourceItems: unknown[] = Array.isArray(root.items)
    ? root.items as unknown[]
    : Array.isArray(root.profiles)
      ? (objectRecord(root.profiles.find((profile) => objectRecord(profile)?.id === "desk"))?.items as unknown[] ?? [])
      : [];
  return {
    schemaVersion: "overview.layout.v2",
    profileId: "samsung-control",
    presetId: "overview.default",
    presetVersion: 2,
    revision: typeof root.revision === "number" && Number.isInteger(root.revision) ? root.revision : 0,
    viewportClass: "landscape-12",
    updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : "1970-01-01T00:00:00+00:00",
    items: sourceItems.map((value, index) => {
      const item = objectRecord(value) ?? {};
      const widgetType = legacyWidgetType(item.widgetType ?? item.widget_id ?? item.widgetId);
      const placement = objectRecord(item.placement) ?? item;
      return {
        instanceId: safeId(item.instanceId ?? item.widget_id, `legacy.item.${index}`),
        widgetType,
        visibility: item.visibility === "hidden" ? "hidden" : "visible",
        placement: {
          x: typeof placement.x === "number" ? placement.x : 0,
          y: typeof placement.y === "number" ? placement.y : 0,
          w: typeof placement.w === "number" ? placement.w : placement.width,
          h: typeof placement.h === "number" ? placement.h : placement.height
        },
        sizeVariant: typeof item.sizeVariant === "string" ? item.sizeVariant : "standard",
        config: objectRecord(item.config) ?? defaultAppearanceConfig(widgetType)
      };
    })
  };
}

export function parseRawLayout(raw: unknown): ParsedOverviewLayout {
  const root = objectRecord(raw);
  if (!root) {
    return {
      items: makeShippedOverviewDocument().items,
      warnings: ["Корень сохранённой панели повреждён."],
      unplaced: [],
      usedFallback: true
    };
  }
  const migrated = root.schemaVersion === "overview.layout.v1" || root.version === 1 ? migrateV1ToV2(root) : root;
  const document = objectRecord(migrated);
  const sourceItems = document && Array.isArray(document.items) ? document.items : null;
  if (!document || document.schemaVersion !== "overview.layout.v2" || !sourceItems) {
    return {
      items: makeShippedOverviewDocument().items,
      warnings: ["Схема сохранённой панели не распознана."],
      unplaced: [],
      usedFallback: true
    };
  }
  const warnings: string[] = [];
  const unplaced: OverviewUnplacedWidget[] = [];
  const items: OverviewLayoutItem[] = [];
  for (const [index, rawItem] of sourceItems.entries()) {
    const candidate = objectRecord(rawItem);
    const widgetType = candidate?.widgetType;
    const instanceId = safeId(candidate?.instanceId, `stored.item.${index}`);
    if (typeof widgetType !== "string" || !getOverviewWidgetDefinition(widgetType)) {
      unplaced.push({ instanceId, widgetType: String(widgetType ?? "unknown"), reason: "Виджет не зарегистрирован в текущей версии панели." });
      continue;
    }
    const definition = getOverviewWidgetDefinition(widgetType);
    const sizeVariant = typeof candidate?.sizeVariant === "string" && definition && definition.sizes[candidate.sizeVariant as keyof typeof definition.sizes]
      ? candidate.sizeVariant
      : definition?.defaultSizeVariant;
    const placement = objectRecord(candidate?.placement);
    if (!definition || !sizeVariant || !placement || ![placement.x, placement.y, placement.w, placement.h].every((value) => typeof value === "number" && Number.isInteger(value))) {
      warnings.push(`${instanceId}: размещение восстановлено шаблоном.`);
      continue;
    }
    items.push({
      instanceId,
      widgetType,
      visibility: candidate?.visibility === "hidden" ? "hidden" : "visible",
      placement: {
        x: Math.max(0, Math.min(12 - Number(placement.w), Number(placement.x))),
        y: Math.max(0, Number(placement.y)),
        w: Number(placement.w),
        h: Number(placement.h)
      },
      sizeVariant,
      config: objectRecord(candidate?.config) as OverviewLayoutItem["config"]
    });
  }
  if (!items.length) {
    return {
      items: makeShippedOverviewDocument().items,
      warnings: [...warnings, "В сохранённой панели не осталось валидных виджетов."],
      unplaced,
      usedFallback: true
    };
  }
  return { items: normalizeLayoutItems(items), warnings, unplaced, usedFallback: false };
}
