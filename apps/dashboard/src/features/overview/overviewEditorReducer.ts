import type {
  OverviewConfigValue,
  OverviewLayoutDocument,
  OverviewLayoutItem,
  OverviewWidgetPlacement
} from "@artem/contracts";
import { defaultAppearanceConfig, normalizeLayoutItem, normalizeLayoutItems, stableSerialize, validateAppearanceConfig } from "./appearanceConfig";
import {
  findFirstFit,
  rectanglesOverlap,
  validateOverviewLayout
} from "./layoutValidation";
import { getOverviewWidgetDefinition, resolveOverviewWidgetSize } from "./overviewRegistry";
import { overviewFoundationLayout } from "./overviewFixture";

export type OverviewEditorMode = "normal" | "editing" | "saving" | "uncertain";

export interface OverviewEditorState {
  readonly mode: OverviewEditorMode;
  readonly canonical: OverviewLayoutDocument;
  readonly entrySnapshot: OverviewLayoutDocument | null;
  readonly draft: OverviewLayoutItem[];
  readonly selectedInstanceId: string | null;
  readonly message: string | null;
  readonly conflict: boolean;
  readonly dirtyOverride: boolean;
}

export type OverviewEditorAction =
  | { type: "hydrate"; document: OverviewLayoutDocument }
  | { type: "enter" }
  | { type: "select"; instanceId: string | null }
  | { type: "move"; instanceId: string; dx: number; dy: number }
  | { type: "resize"; instanceId: string; sizeVariant: string }
  | { type: "add"; widgetType: string }
  | { type: "remove"; instanceId: string }
  | { type: "restore"; widgetType: string }
  | { type: "set-config"; instanceId: string; key: string; value: OverviewConfigValue }
  | { type: "reset-widget-config"; instanceId: string }
  | { type: "reset" }
  | { type: "cancel" }
  | { type: "save-started" }
  | { type: "save-succeeded"; document: OverviewLayoutDocument }
  | { type: "save-failed"; message: string }
  | { type: "save-conflict"; message: string }
  | { type: "save-uncertain"; message: string }
  | { type: "load-server"; document: OverviewLayoutDocument }
  | { type: "message"; message: string }
  | { type: "clear-message" };

function cloneDocument(document: OverviewLayoutDocument): OverviewLayoutDocument {
  return {
    ...document,
    items: normalizeLayoutItems(document.items),
    warnings: document.warnings ? [...document.warnings] : [],
    unplaced: document.unplaced ? document.unplaced.map((record) => ({ ...record })) : []
  };
}

export function cloneOverviewItems(items: readonly OverviewLayoutItem[]): OverviewLayoutItem[] {
  return normalizeLayoutItems(items).map((item) => ({
    ...item,
    placement: { ...item.placement },
    config: item.config ? { ...item.config } : {}
  }));
}

export function makeShippedOverviewDocument(writesEnabled = false): OverviewLayoutDocument {
  return {
    schemaVersion: "overview.layout.v2",
    profileId: "samsung-control",
    presetId: "overview.default",
    presetVersion: 2,
    revision: 0,
    viewportClass: "landscape-12",
    updatedAt: "1970-01-01T00:00:00+00:00",
    items: cloneOverviewItems(overviewFoundationLayout()),
    warnings: [],
    unplaced: [],
    writesEnabled
  };
}

export function normalizeOverviewDocument(
  document: Partial<OverviewLayoutDocument> | null | undefined,
  writesEnabled = false
): OverviewLayoutDocument {
  const fallback = makeShippedOverviewDocument(writesEnabled);
  if (!document || !Array.isArray(document.items)) return fallback;
  return cloneDocument({
    ...fallback,
    ...document,
    items: document.items,
    writesEnabled: document.writesEnabled ?? writesEnabled
  } as OverviewLayoutDocument);
}

export function overviewItemsEqual(left: readonly OverviewLayoutItem[], right: readonly OverviewLayoutItem[]): boolean {
  return stableSerialize(cloneOverviewItems(left)) === stableSerialize(cloneOverviewItems(right));
}

export function overviewEditorDirty(state: Pick<OverviewEditorState, "mode" | "draft" | "entrySnapshot" | "dirtyOverride">): boolean {
  return state.entrySnapshot !== null && (state.dirtyOverride || !overviewItemsEqual(state.draft, state.entrySnapshot.items));
}

export function createOverviewEditorState(document: OverviewLayoutDocument): OverviewEditorState {
  const canonical = normalizeOverviewDocument(document, document.writesEnabled ?? false);
  return {
    mode: "normal",
    canonical,
    entrySnapshot: null,
    draft: cloneOverviewItems(canonical.items),
    selectedInstanceId: null,
    message: null,
    conflict: false,
    dirtyOverride: false
  };
}

function safeDelta(value: number): number {
  return Number.isInteger(value) ? value : 0;
}

function isVisible(item: OverviewLayoutItem): boolean {
  return (item.visibility ?? "visible") === "visible";
}

function candidateWithinBounds(placement: OverviewWidgetPlacement): boolean {
  return placement.x >= 0 && placement.y >= 0 && placement.w > 0 && placement.h > 0 &&
    placement.x + placement.w <= 12 && placement.h <= 8;
}

interface PlacementOperationResult {
  readonly ok: boolean;
  readonly items: OverviewLayoutItem[];
  readonly message?: string;
}

/**
 * Resolve a moved/resized anchor first. Every later collision keeps its x and
 * width and is pushed down in stable draft order; no lateral shuffle occurs.
 */
function resolveAnchorChange(
  items: readonly OverviewLayoutItem[],
  instanceId: string,
  anchorPlacement: OverviewWidgetPlacement,
  anchorVariant: string
): PlacementOperationResult {
  const anchor = items.find((item) => item.instanceId === instanceId);
  if (!anchor || !candidateWithinBounds(anchorPlacement)) {
    return { ok: false, items: cloneOverviewItems(items), message: "Этот размер или положение выходит за пределы сетки." };
  }

  const definition = getOverviewWidgetDefinition(anchor.widgetType);
  const named = definition ? resolveOverviewWidgetSize(definition, anchorVariant) : null;
  if (!definition || !named || named.w !== anchorPlacement.w || named.h !== anchorPlacement.h) {
    return { ok: false, items: cloneOverviewItems(items), message: "Для этого виджета нет такого зарегистрированного размера." };
  }

  const occupied: OverviewWidgetPlacement[] = [anchorPlacement];
  const resolvedById = new Map<string, OverviewWidgetPlacement>([[instanceId, anchorPlacement]]);
  for (const item of items) {
    if (item.instanceId === instanceId || !isVisible(item)) continue;
    let placement = { ...item.placement };
    while (occupied.some((rectangle) => rectanglesOverlap(placement, rectangle))) {
      placement = { ...placement, y: placement.y + 1 };
    }
    resolvedById.set(item.instanceId, placement);
    occupied.push(placement);
  }

  const next = items.map((item) => {
    const placement = resolvedById.get(item.instanceId);
    if (!placement) return { ...item, placement: { ...item.placement } };
    return {
      ...item,
      placement: { ...placement },
      sizeVariant: item.instanceId === instanceId ? anchorVariant : item.sizeVariant
    };
  });
  const validation = validateOverviewLayout(next);
  if (!validation.valid) {
    return { ok: false, items: cloneOverviewItems(items), message: "Изменение создаёт недопустимую конфигурацию." };
  }
  return { ok: true, items: cloneOverviewItems(next) };
}

export function moveOverviewItem(
  items: readonly OverviewLayoutItem[],
  instanceId: string,
  dx: number,
  dy: number
): PlacementOperationResult {
  const item = items.find((entry) => entry.instanceId === instanceId);
  if (!item) return { ok: false, items: cloneOverviewItems(items), message: "Виджет не найден." };
  return resolveAnchorChange(
    items,
    instanceId,
    {
      ...item.placement,
      x: item.placement.x + safeDelta(dx),
      y: item.placement.y + safeDelta(dy)
    },
    item.sizeVariant
  );
}

export function resizeOverviewItem(
  items: readonly OverviewLayoutItem[],
  instanceId: string,
  sizeVariant: string
): PlacementOperationResult {
  const item = items.find((entry) => entry.instanceId === instanceId);
  const definition = item ? getOverviewWidgetDefinition(item.widgetType) : null;
  const size = definition ? resolveOverviewWidgetSize(definition, sizeVariant) : null;
  if (!item || !size) return { ok: false, items: cloneOverviewItems(items), message: "Размер не поддерживается этим виджетом." };
  return resolveAnchorChange(
    items,
    instanceId,
    { ...item.placement, w: size.w, h: size.h },
    sizeVariant
  );
}

function nextInstanceId(widgetType: string, items: readonly OverviewLayoutItem[]): string {
  const prefix = `widget.${widgetType.replace(/[^a-z0-9]+/g, ".")}`;
  const used = new Set(items.map((item) => item.instanceId));
  if (!used.has(`${prefix}.primary`)) return `${prefix}.primary`;
  let index = 2;
  while (used.has(`${prefix}.${index}`)) index += 1;
  return `${prefix}.${index}`;
}

export function addOverviewWidget(
  items: readonly OverviewLayoutItem[],
  widgetType: string
): PlacementOperationResult {
  const definition = getOverviewWidgetDefinition(widgetType);
  if (!definition) return { ok: false, items: cloneOverviewItems(items), message: "Виджет не зарегистрирован." };
  const existing = items.find((item) => item.widgetType === widgetType);
  if (existing && definition.singleton && isVisible(existing)) {
    return { ok: false, items: cloneOverviewItems(items), message: "Этот виджет уже добавлен." };
  }
  const variant = existing?.sizeVariant && resolveOverviewWidgetSize(definition, existing.sizeVariant)
    ? existing.sizeVariant
    : definition.defaultSizeVariant;
  const size = resolveOverviewWidgetSize(definition, variant);
  if (!size) return { ok: false, items: cloneOverviewItems(items), message: "У виджета нет безопасного размера." };
  const occupied = items.filter(isVisible).map((item) => item.placement);
  const placement = findFirstFit(size, occupied, 12, 0);
  if (!placement) return { ok: false, items: cloneOverviewItems(items), message: "Для виджета не найдено безопасное место." };
  if (existing && definition.singleton) {
    return {
      ok: true,
      items: cloneOverviewItems(items.map((item) => item.instanceId === existing.instanceId
        ? { ...item, visibility: "visible", placement, sizeVariant: variant }
        : item))
    };
  }
  const newItem: OverviewLayoutItem = normalizeLayoutItem({
    instanceId: nextInstanceId(widgetType, items),
    widgetType,
    visibility: "visible",
    placement,
    sizeVariant: variant,
    config: defaultAppearanceConfig(widgetType)
  });
  return { ok: true, items: [...cloneOverviewItems(items), newItem] };
}

export function removeOverviewWidget(items: readonly OverviewLayoutItem[], instanceId: string): OverviewLayoutItem[] {
  return cloneOverviewItems(items).map((item) => item.instanceId === instanceId
    ? { ...item, visibility: "hidden" }
    : item);
}

export function restoreOverviewWidget(items: readonly OverviewLayoutItem[], widgetType: string): PlacementOperationResult {
  return addOverviewWidget(items, widgetType);
}

export function setOverviewItemConfig(
  items: readonly OverviewLayoutItem[],
  instanceId: string,
  key: string,
  value: OverviewConfigValue
): OverviewLayoutItem[] {
  return cloneOverviewItems(items).map((item) => {
    if (item.instanceId !== instanceId) return item;
    const nextConfig = { ...(item.config ?? {}), [key]: value };
    const validation = validateAppearanceConfig(item.widgetType, nextConfig, true);
    return validation.valid ? { ...item, config: validation.value } : item;
  });
}

export function resetOverviewItemConfig(items: readonly OverviewLayoutItem[], instanceId: string): OverviewLayoutItem[] {
  return cloneOverviewItems(items).map((item) => item.instanceId === instanceId
    ? { ...item, config: defaultAppearanceConfig(item.widgetType) }
    : item);
}

function editingState(state: OverviewEditorState, draft: readonly OverviewLayoutItem[], message: string | null = null): OverviewEditorState {
  return { ...state, draft: cloneOverviewItems(draft), message, conflict: false };
}

export function overviewEditorReducer(
  state: OverviewEditorState,
  action: OverviewEditorAction
): OverviewEditorState {
  switch (action.type) {
    case "hydrate": {
      const canonical = cloneDocument(action.document);
      return {
        ...state,
        mode: "normal",
        canonical,
        entrySnapshot: null,
        draft: cloneOverviewItems(canonical.items),
        selectedInstanceId: null,
        message: null,
        conflict: false,
        dirtyOverride: false
      };
    }
    case "enter": {
      const entrySnapshot = cloneDocument(state.canonical);
      return {
        ...state,
        mode: "editing",
        entrySnapshot,
        draft: cloneOverviewItems(entrySnapshot.items),
        selectedInstanceId: null,
        message: null,
        conflict: false,
        dirtyOverride: false
      };
    }
    case "select":
      return { ...state, selectedInstanceId: action.instanceId };
    case "move": {
      if (state.mode !== "editing") return state;
      const result = moveOverviewItem(state.draft, action.instanceId, action.dx, action.dy);
      return editingState(state, result.items, result.ok ? null : result.message ?? null);
    }
    case "resize": {
      if (state.mode !== "editing") return state;
      const result = resizeOverviewItem(state.draft, action.instanceId, action.sizeVariant);
      return editingState(state, result.items, result.ok ? null : result.message ?? null);
    }
    case "add": {
      if (state.mode !== "editing") return state;
      const result = addOverviewWidget(state.draft, action.widgetType);
      return editingState(state, result.items, result.ok ? null : result.message ?? null);
    }
    case "remove":
      return state.mode === "editing"
        ? editingState(state, removeOverviewWidget(state.draft, action.instanceId))
        : state;
    case "restore": {
      if (state.mode !== "editing") return state;
      const result = restoreOverviewWidget(state.draft, action.widgetType);
      return editingState(state, result.items, result.ok ? null : result.message ?? null);
    }
    case "set-config":
      return state.mode === "editing"
        ? editingState(state, setOverviewItemConfig(state.draft, action.instanceId, action.key, action.value))
        : state;
    case "reset-widget-config":
      return state.mode === "editing"
        ? editingState(state, resetOverviewItemConfig(state.draft, action.instanceId))
        : state;
    case "reset":
      return state.mode === "editing"
        ? {
            ...editingState(state, overviewFoundationLayout(), "Восстановлен шаблон по умолчанию. Нажмите «Готово», чтобы сохранить его."),
            dirtyOverride: true
          }
        : state;
    case "cancel":
      return state.entrySnapshot
        ? {
            ...state,
            mode: "normal",
            draft: cloneOverviewItems(state.entrySnapshot.items),
            entrySnapshot: null,
            selectedInstanceId: null,
            message: null,
            conflict: false,
            dirtyOverride: false
          }
        : state;
    case "save-started":
      return state.mode === "editing" ? { ...state, mode: "saving", message: null } : state;
    case "save-succeeded": {
      const canonical = cloneDocument(action.document);
      return {
        ...state,
        mode: "normal",
        canonical,
        draft: cloneOverviewItems(canonical.items),
        entrySnapshot: null,
        selectedInstanceId: null,
        message: null,
        conflict: false,
        dirtyOverride: false
      };
    }
    case "save-failed":
      return state.mode === "saving"
        ? { ...state, mode: "editing", message: action.message, conflict: false }
        : state;
    case "save-conflict":
      return { ...state, mode: "editing", message: action.message, conflict: true };
    case "save-uncertain":
      return { ...state, mode: "uncertain", message: action.message, conflict: false };
    case "load-server": {
      const canonical = cloneDocument(action.document);
      return {
        ...state,
        mode: "editing",
        canonical,
        entrySnapshot: canonical,
        draft: cloneOverviewItems(canonical.items),
        selectedInstanceId: null,
        message: null,
        conflict: false,
        dirtyOverride: false
      };
    }
    case "message":
      return { ...state, message: action.message };
    case "clear-message":
      return { ...state, message: null };
    default:
      return state;
  }
}
