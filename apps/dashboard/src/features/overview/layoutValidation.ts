import type {
  OverviewLayoutItem,
  OverviewWidgetPlacement,
  OverviewWidgetSizeVariant
} from "@artem/contracts";
import {
  overviewWidgetRegistry,
  resolveOverviewWidgetSize,
  type OverviewWidgetDefinition
} from "./overviewRegistry";

export const OVERVIEW_CANONICAL_COLUMNS = 12;
export const OVERVIEW_MAX_WIDGET_ROWS = 8;
export const OVERVIEW_GENERIC_MIN_WIDTH = 3;
export const OVERVIEW_GENERIC_MIN_HEIGHT = 1;

export type OverviewGridProfileId = "landscape-12" | "medium-8" | "compact-4";

export interface OverviewGridProfile {
  readonly id: OverviewGridProfileId;
  readonly columns: 12 | 8 | 4;
  readonly rowHeight: number | "auto";
  readonly gap: 12 | 10;
}

export type OverviewLayoutIssueCode =
  | "invalid-instance-id"
  | "duplicate-instance-id"
  | "unknown-widget-type"
  | "unknown-size-variant"
  | "invalid-integer"
  | "negative-x"
  | "negative-y"
  | "invalid-width"
  | "invalid-height"
  | "column-overflow"
  | "widget-height-overflow"
  | "minimum-size"
  | "maximum-size"
  | "variant-dimension-mismatch"
  | "duplicate-singleton"
  | "overlap"
  | "responsive-unsupported";

export interface OverviewLayoutIssue {
  readonly code: OverviewLayoutIssueCode;
  readonly instanceId: string | null;
  readonly widgetType: string | null;
  readonly message: string;
}

export interface OverviewValidationRecord {
  readonly index: number;
  readonly item: OverviewLayoutItem;
  readonly definition: OverviewWidgetDefinition | null;
  readonly issues: readonly OverviewLayoutIssue[];
  readonly valid: boolean;
}

export interface OverviewValidationResult {
  readonly valid: boolean;
  readonly issues: readonly OverviewLayoutIssue[];
  readonly records: readonly OverviewValidationRecord[];
  readonly validItems: readonly OverviewLayoutItem[];
}

export type OverviewProjectionItemState = "rendered" | "fallback";
export type OverviewFallbackReason = "unknown" | "invalid-layout" | "unsupported-profile";

export interface OverviewProjectionItem {
  readonly canonicalIndex: number;
  readonly item: OverviewLayoutItem;
  readonly placement: OverviewWidgetPlacement;
  readonly sizeVariant: OverviewWidgetSizeVariant | null;
  readonly definition: OverviewWidgetDefinition | null;
  readonly state: OverviewProjectionItemState;
  readonly fallbackReason?: OverviewFallbackReason;
}

export interface OverviewProjectionResult {
  readonly profile: OverviewGridProfile;
  readonly items: readonly OverviewProjectionItem[];
  readonly issues: readonly OverviewLayoutIssue[];
}

interface LayoutRecord {
  readonly index: number;
  readonly item: OverviewLayoutItem;
  readonly instanceId: string | null;
  readonly widgetType: string | null;
  readonly sizeVariant: string | null;
  readonly placement: OverviewWidgetPlacement | null;
  readonly definition: OverviewWidgetDefinition | null;
  readonly issues: OverviewLayoutIssue[];
}

function cloneItem(item: OverviewLayoutItem): OverviewLayoutItem {
  return {
    instanceId: item.instanceId,
    widgetType: item.widgetType,
    sizeVariant: item.sizeVariant,
    placement: { ...item.placement }
  };
}

function issue(
  code: OverviewLayoutIssueCode,
  instanceId: string | null,
  widgetType: string | null,
  message: string
): OverviewLayoutIssue {
  return { code, instanceId, widgetType, message };
}

function addIssue(
  record: LayoutRecord,
  code: OverviewLayoutIssueCode,
  message: string
): void {
  record.issues.push(issue(code, record.instanceId, record.widgetType, message));
}

function recordValue(record: Record<string, unknown> | null, key: string): unknown {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function parseRecord(
  index: number,
  item: OverviewLayoutItem,
  registryMap: ReadonlyMap<string, OverviewWidgetDefinition>
): LayoutRecord {
  const candidate = item && typeof item === "object"
    ? item as unknown as Record<string, unknown>
    : null;
  const instanceId = typeof recordValue(candidate, "instanceId") === "string"
    ? String(recordValue(candidate, "instanceId"))
    : null;
  const widgetType = typeof recordValue(candidate, "widgetType") === "string"
    ? String(recordValue(candidate, "widgetType"))
    : null;
  const sizeVariant = typeof recordValue(candidate, "sizeVariant") === "string"
    ? String(recordValue(candidate, "sizeVariant"))
    : null;
  const rawPlacement = recordValue(candidate, "placement");
  const placementRecord = rawPlacement && typeof rawPlacement === "object"
    ? rawPlacement as Record<string, unknown>
    : null;
  const numericPlacement = placementRecord && ["x", "y", "w", "h"].every((key) =>
    typeof recordValue(placementRecord, key) === "number"
  )
    ? {
        x: Number(recordValue(placementRecord, "x")),
        y: Number(recordValue(placementRecord, "y")),
        w: Number(recordValue(placementRecord, "w")),
        h: Number(recordValue(placementRecord, "h"))
      }
    : null;
  const definition = widgetType ? registryMap.get(widgetType) ?? null : null;
  const normalizedItem: OverviewLayoutItem = {
    instanceId: instanceId ?? "",
    widgetType: widgetType ?? "",
    sizeVariant: sizeVariant ?? "",
    placement: numericPlacement ?? { x: 0, y: 0, w: 0, h: 0 }
  };
  const record: LayoutRecord = {
    index,
    item: normalizedItem,
    instanceId,
    widgetType,
    sizeVariant,
    placement: numericPlacement,
    definition,
    issues: []
  };

  if (!instanceId) addIssue(record, "invalid-instance-id", "Every Overview item needs an instanceId.");
  if (!widgetType) addIssue(record, "unknown-widget-type", "The Overview widget type is unavailable.");
  if (widgetType && !definition) {
    addIssue(record, "unknown-widget-type", "The Overview widget type is not registered.");
  }
  if (!sizeVariant) addIssue(record, "unknown-size-variant", "The Overview size variant is unavailable.");
  if (sizeVariant && definition && !resolveOverviewWidgetSize(definition, sizeVariant)) {
    addIssue(record, "unknown-size-variant", "The named Overview size variant is not registered.");
  }
  if (!numericPlacement) {
    addIssue(record, "invalid-integer", "Overview placement must contain numeric x, y, w and h values.");
    return record;
  }

  if (![numericPlacement.x, numericPlacement.y, numericPlacement.w, numericPlacement.h].every(Number.isInteger)) {
    addIssue(record, "invalid-integer", "Overview placement units must be integers.");
  }
  if (numericPlacement.x < 0) addIssue(record, "negative-x", "Overview x cannot be negative.");
  if (numericPlacement.y < 0) addIssue(record, "negative-y", "Overview y cannot be negative.");
  if (numericPlacement.w <= 0) addIssue(record, "invalid-width", "Overview width must be positive.");
  if (numericPlacement.h <= 0) addIssue(record, "invalid-height", "Overview height must be positive.");
  if (numericPlacement.x + numericPlacement.w > OVERVIEW_CANONICAL_COLUMNS) {
    addIssue(record, "column-overflow", "Overview placement must stay within 12 columns.");
  }
  if (numericPlacement.h > OVERVIEW_MAX_WIDGET_ROWS) {
    addIssue(record, "widget-height-overflow", "Overview widgets may be at most 8 rows high.");
  }
  if (numericPlacement.w < OVERVIEW_GENERIC_MIN_WIDTH || numericPlacement.h < OVERVIEW_GENERIC_MIN_HEIGHT) {
    addIssue(record, "minimum-size", "Overview widgets must be at least 3 × 1 unless their manifest is more restrictive.");
  }

  if (definition) {
    if (numericPlacement.w < definition.minW || numericPlacement.h < definition.minH) {
      addIssue(record, "minimum-size", "The placement is below the registered widget minimum.");
    }
    if (numericPlacement.w > definition.maxW || numericPlacement.h > definition.maxH) {
      addIssue(record, "maximum-size", "The placement exceeds the registered widget maximum.");
    }
    const namedSize = sizeVariant ? resolveOverviewWidgetSize(definition, sizeVariant) : null;
    if (namedSize && (numericPlacement.w !== namedSize.w || numericPlacement.h !== namedSize.h)) {
      addIssue(record, "variant-dimension-mismatch", "The placement does not match its named size variant.");
    }
  }
  return record;
}

function addUniqueIssue(record: LayoutRecord, next: OverviewLayoutIssue): void {
  if (!record.issues.some((current) => current.code === next.code && current.message === next.message)) {
    record.issues.push(next);
  }
}

export function rectanglesOverlap(
  first: OverviewWidgetPlacement,
  second: OverviewWidgetPlacement
): boolean {
  return (
    first.x < second.x + second.w &&
    second.x < first.x + first.w &&
    first.y < second.y + second.h &&
    second.y < first.y + first.h
  );
}

export function validateOverviewLayout(
  items: readonly OverviewLayoutItem[],
  registry: readonly OverviewWidgetDefinition[] = overviewWidgetRegistry
): OverviewValidationResult {
  const registryMap = new Map<string, OverviewWidgetDefinition>(registry.map((entry) => [entry.widgetType, entry]));
  const records = items.map((item, index) => parseRecord(index, item, registryMap));
  const firstByInstanceId = new Map<string, LayoutRecord>();
  const firstBySingletonType = new Map<string, LayoutRecord>();

  for (const record of records) {
    if (record.instanceId) {
      const first = firstByInstanceId.get(record.instanceId);
      if (first) {
        addIssue(record, "duplicate-instance-id", "instanceId must be unique.");
        addUniqueIssue(first, issue("duplicate-instance-id", first.instanceId, first.widgetType, "instanceId must be unique."));
      } else {
        firstByInstanceId.set(record.instanceId, record);
      }
    }
    if (record.definition?.singleton && record.widgetType) {
      const first = firstBySingletonType.get(record.widgetType);
      if (first) {
        addIssue(record, "duplicate-singleton", "A singleton Overview widget may appear only once.");
        addUniqueIssue(first, issue("duplicate-singleton", first.instanceId, first.widgetType, "A singleton Overview widget may appear only once."));
      } else {
        firstBySingletonType.set(record.widgetType, record);
      }
    }
  }

  for (let index = 0; index < records.length; index += 1) {
    const first = records[index];
    if (!first.placement || first.issues.some((current) => current.code === "invalid-integer")) continue;
    for (let nextIndex = index + 1; nextIndex < records.length; nextIndex += 1) {
      const second = records[nextIndex];
      if (!second.placement || second.issues.some((current) => current.code === "invalid-integer")) continue;
      if (!rectanglesOverlap(first.placement, second.placement)) continue;
      addIssue(first, "overlap", "Overview rectangles may not overlap.");
      addIssue(second, "overlap", "Overview rectangles may not overlap.");
    }
  }

  const issues = records.flatMap((record) => record.issues);
  const validatedRecords: readonly OverviewValidationRecord[] = records.map((record) => ({
    index: record.index,
    item: cloneItem(record.item),
    definition: record.definition,
    issues: [...record.issues],
    valid: record.issues.length === 0
  }));
  return {
    valid: issues.length === 0,
    issues,
    records: validatedRecords,
    validItems: validatedRecords
      .filter((record) => record.valid)
      .map((record) => cloneItem(record.item))
  };
}

export function profileForWorkspaceWidth(width: number): OverviewGridProfile {
  const safeWidth = Number.isFinite(width) ? width : 1064;
  if (safeWidth >= 960) {
    return { id: "landscape-12", columns: 12, rowHeight: 60, gap: 12 };
  }
  if (safeWidth >= 720) {
    return { id: "medium-8", columns: 8, rowHeight: 64, gap: 12 };
  }
  return { id: "compact-4", columns: 4, rowHeight: "auto", gap: 10 };
}

function sortNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCanonicalItems(
  left: OverviewLayoutItem,
  leftIndex: number,
  right: OverviewLayoutItem,
  rightIndex: number
): number {
  return (
    sortNumber(left?.placement?.y) - sortNumber(right?.placement?.y) ||
    sortNumber(left?.placement?.x) - sortNumber(right?.placement?.x) ||
    compareStableStrings(
      typeof left?.instanceId === "string" ? left.instanceId : "",
      typeof right?.instanceId === "string" ? right.instanceId : ""
    ) ||
    leftIndex - rightIndex
  );
}

export function sortCanonicalLayoutItems(
  items: readonly OverviewLayoutItem[]
): readonly OverviewLayoutItem[] {
  return items
    .map((item, index) => ({
      item,
      index
    }))
    .sort((left, right) =>
      compareCanonicalItems(left.item, left.index, right.item, right.index)
    )
    .map(({ item }) => cloneItem(item));
}

export function sortCanonicalValidationRecords(
  records: readonly OverviewValidationRecord[]
): readonly OverviewValidationRecord[] {
  return records
    .slice()
    .sort((left, right) => compareCanonicalItems(left.item, left.index, right.item, right.index));
}

export function findFirstFit(
  size: Pick<OverviewWidgetPlacement, "w" | "h">,
  occupied: readonly OverviewWidgetPlacement[],
  columns: number,
  startY = 0
): OverviewWidgetPlacement | null {
  if (!Number.isInteger(size.w) || !Number.isInteger(size.h) || size.w <= 0 || size.h <= 0) return null;
  if (!Number.isInteger(columns) || columns <= 0 || size.w > columns) return null;
  const firstRow = Number.isInteger(startY) && startY >= 0 ? startY : 0;
  const bottom = occupied.reduce(
    (highest, rectangle) => Math.max(highest, rectangle.y + rectangle.h),
    firstRow
  );
  for (let y = firstRow; y <= bottom; y += 1) {
    for (let x = 0; x <= columns - size.w; x += 1) {
      const candidate = { x, y, w: size.w, h: size.h };
      if (!occupied.some((rectangle) => rectanglesOverlap(candidate, rectangle))) return candidate;
    }
  }
  return { x: 0, y: Math.max(firstRow, bottom), w: size.w, h: size.h };
}

export function pushDownPlacement(
  proposed: OverviewWidgetPlacement,
  occupied: readonly OverviewWidgetPlacement[]
): OverviewWidgetPlacement {
  let y = proposed.y;
  while (occupied.some((rectangle) => rectanglesOverlap({ ...proposed, y }, rectangle))) {
    y += 1;
  }
  return { ...proposed, y };
}

export function resolvePushDown(
  placements: readonly OverviewWidgetPlacement[]
): readonly OverviewWidgetPlacement[] {
  const occupied: OverviewWidgetPlacement[] = [];
  for (const placement of placements) {
    const resolved = pushDownPlacement(placement, occupied);
    occupied.push(resolved);
  }
  return occupied;
}

function chooseResponsiveVariant(
  definition: OverviewWidgetDefinition,
  requestedVariant: string,
  columns: number
): { variant: OverviewWidgetSizeVariant; size: { w: number; h: number } } | null {
  const requested = resolveOverviewWidgetSize(definition, requestedVariant);
  if (requested && requested.w <= columns) {
    return { variant: requestedVariant as OverviewWidgetSizeVariant, size: requested };
  }
  const requestedLimit = requested ?? resolveOverviewWidgetSize(definition, definition.defaultSizeVariant);
  if (!requestedLimit) return null;
  const candidates = Object.entries(definition.sizes)
    .flatMap(([variant, size]) => size ? [{ variant: variant as OverviewWidgetSizeVariant, size }] : [])
    .filter(({ size }) =>
      size.w <= columns &&
      size.w <= requestedLimit.w &&
      size.h <= requestedLimit.h
    )
    .sort((left, right) =>
      right.size.w * right.size.h - left.size.w * left.size.h ||
      right.size.w - left.size.w ||
      right.size.h - left.size.h ||
      compareStableStrings(left.variant, right.variant)
    );
  return candidates[0] ?? null;
}

const FALLBACK_SIZE = { w: 3, h: 1 } as const;

function safeStartY(item: OverviewLayoutItem): number {
  return Number.isInteger(item.placement?.y) && item.placement.y >= 0
    ? item.placement.y
    : 0;
}

export function projectOverviewLayout(
  canonicalItems: readonly OverviewLayoutItem[],
  workspaceWidth: number
): OverviewProjectionResult {
  const profile = profileForWorkspaceWidth(workspaceWidth);
  const validation = validateOverviewLayout(canonicalItems);
  const projected: OverviewProjectionItem[] = [];
  const occupied: OverviewWidgetPlacement[] = [];
  const issues = [...validation.issues];

  for (const record of sortCanonicalValidationRecords(validation.records)) {
    const { item, definition } = record;
    if (!definition) {
      const placement = findFirstFit(FALLBACK_SIZE, occupied, profile.columns, safeStartY(item));
      if (!placement) continue;
      projected.push({
        canonicalIndex: record.index,
        item,
        placement,
        sizeVariant: null,
        definition: null,
        state: "fallback",
        fallbackReason: "unknown"
      });
      occupied.push(placement);
      continue;
    }

    if (!record.valid) {
      const placement = findFirstFit(FALLBACK_SIZE, occupied, profile.columns);
      if (!placement) continue;
      projected.push({
        canonicalIndex: record.index,
        item,
        placement,
        sizeVariant: null,
        definition,
        state: "fallback",
        fallbackReason: "invalid-layout"
      });
      occupied.push(placement);
      continue;
    }

    const selected = chooseResponsiveVariant(definition, item.sizeVariant, profile.columns);
    if (!selected) {
      issues.push(issue(
        "responsive-unsupported",
        item.instanceId,
        item.widgetType,
        "No registered size variant fits the target Overview profile."
      ));
      const placement = findFirstFit(FALLBACK_SIZE, occupied, profile.columns, safeStartY(item));
      if (!placement) continue;
      projected.push({
        canonicalIndex: record.index,
        item,
        placement,
        sizeVariant: null,
        definition,
        state: "fallback",
        fallbackReason: "unsupported-profile"
      });
      occupied.push(placement);
      continue;
    }

    const canonicalPlacement = item.placement;
    const canKeepCanonical = profile.columns === OVERVIEW_CANONICAL_COLUMNS &&
      Number.isInteger(canonicalPlacement?.x) &&
      Number.isInteger(canonicalPlacement?.y) &&
      Number.isInteger(canonicalPlacement?.w) &&
      Number.isInteger(canonicalPlacement?.h) &&
      canonicalPlacement.x >= 0 &&
      canonicalPlacement.y >= 0 &&
      canonicalPlacement.x + canonicalPlacement.w <= profile.columns &&
      canonicalPlacement.w === selected.size.w &&
      canonicalPlacement.h === selected.size.h &&
      !occupied.some((rectangle) => rectanglesOverlap(canonicalPlacement, rectangle));
    const placement = canKeepCanonical
      ? { ...canonicalPlacement }
      : findFirstFit(selected.size, occupied, profile.columns);
    if (!placement) continue;
    projected.push({
      canonicalIndex: record.index,
      item,
      placement,
      sizeVariant: selected.variant,
      definition,
      state: "rendered"
    });
    occupied.push(placement);
  }

  return { profile, items: projected, issues };
}
