import type { OverviewConfigValue, OverviewLayoutItem, OverviewWidgetType } from "@artem/contracts";
import schemaDocument from "../../../../../config/overview-appearance-schema.json";

export type AppearanceSection = "Композиция" | "Изображение" | "Отображение";

export type AppearanceControl =
  | {
      readonly key: string;
      readonly control: "integer_range";
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly defaultValue: number;
      readonly label: string;
      readonly section: AppearanceSection;
    }
  | {
      readonly key: string;
      readonly control: "boolean";
      readonly defaultValue: boolean;
      readonly label: string;
      readonly section: AppearanceSection;
    }
  | {
      readonly key: string;
      readonly control: "enum";
      readonly values: readonly { readonly value: string; readonly label: string }[];
      readonly defaultValue: string;
      readonly label: string;
      readonly section: AppearanceSection;
    };

export interface AppearanceSchema {
  readonly defaults: Readonly<Record<string, OverviewConfigValue>>;
  readonly controls: readonly AppearanceControl[];
}

const trustedSchema = schemaDocument as unknown as {
  schemaVersion: string;
  widgets: Record<string, AppearanceSchema>;
};

export const OVERVIEW_APPEARANCE_SCHEMA_VERSION = "overview.appearance.v1" as const;

if (trustedSchema.schemaVersion !== OVERVIEW_APPEARANCE_SCHEMA_VERSION) {
  throw new Error("Unsupported trusted Overview appearance schema");
}

export const overviewAppearanceSchemas: Readonly<Record<string, AppearanceSchema>> = trustedSchema.widgets;

export function appearanceSchemaFor(widgetType: string): AppearanceSchema {
  return overviewAppearanceSchemas[widgetType] ?? { defaults: {}, controls: [] };
}

export function appearanceControlsFor(widgetType: string): readonly AppearanceControl[] {
  return appearanceSchemaFor(widgetType).controls;
}

export function hasAppearanceControls(widgetType: string): boolean {
  return appearanceControlsFor(widgetType).length > 0;
}

export function defaultAppearanceConfig(widgetType: string): Record<string, OverviewConfigValue> {
  return { ...appearanceSchemaFor(widgetType).defaults };
}

export interface AppearanceValidationResult {
  readonly valid: boolean;
  readonly value: Record<string, OverviewConfigValue>;
  readonly errors: readonly string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function valueForControl(control: AppearanceControl, value: unknown): boolean {
  if (control.control === "boolean") return typeof value === "boolean";
  if (control.control === "integer_range") {
    return typeof value === "number" && Number.isInteger(value) &&
      value >= control.min && value <= control.max &&
      (value - control.min) % control.step === 0;
  }
  return typeof value === "string" && control.values.some((entry) => entry.value === value);
}

/**
 * The client uses this for draft edits and read recovery. The Panel Agent
 * repeats the same checks at the persistence boundary.
 */
export function validateAppearanceConfig(
  widgetType: string,
  candidate: unknown,
  strict = false
): AppearanceValidationResult {
  const schema = appearanceSchemaFor(widgetType);
  const source = candidate === undefined ? {} : candidate;
  if (!isPlainRecord(source)) {
    return { valid: false, value: defaultAppearanceConfig(widgetType), errors: ["config must be a flat object"] };
  }

  const errors: string[] = [];
  const value: Record<string, OverviewConfigValue> = {};
  const known = new Map(schema.controls.map((control) => [control.key, control]));
  for (const [key, raw] of Object.entries(source)) {
    const control = known.get(key);
    if (!control) {
      errors.push(`unknown config key: ${key}`);
      continue;
    }
    if (!valueForControl(control, raw)) {
      errors.push(`invalid config value: ${key}`);
      continue;
    }
    value[key] = raw as OverviewConfigValue;
  }
  for (const control of schema.controls) {
    if (!Object.prototype.hasOwnProperty.call(value, control.key)) {
      if (strict && Object.prototype.hasOwnProperty.call(source, control.key)) continue;
      value[control.key] = control.defaultValue;
    }
  }
  return { valid: errors.length === 0, value, errors };
}

export function normalizeLayoutItem(item: OverviewLayoutItem): OverviewLayoutItem {
  const config = validateAppearanceConfig(item.widgetType, item.config).value;
  return {
    ...item,
    visibility: item.visibility ?? "visible",
    config,
    placement: { ...item.placement }
  };
}

export function normalizeLayoutItems(items: readonly OverviewLayoutItem[]): OverviewLayoutItem[] {
  return items.map(normalizeLayoutItem);
}

export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

export function normalizedConfigForItem(item: OverviewLayoutItem): Record<string, OverviewConfigValue> {
  return validateAppearanceConfig(item.widgetType, item.config).value;
}

export interface CoffeeAppearanceConfig {
  imageScalePct: number;
  imageXStep: number;
  imageYStep: number;
  composition: "auto" | "compact" | "spacious";
  buttonLayout: "compact" | "balanced" | "wide";
  showStateMarker: boolean;
  showAuthority: boolean;
  showImage: boolean;
}

export function coffeeAppearanceConfig(item: OverviewLayoutItem): CoffeeAppearanceConfig {
  const value = normalizedConfigForItem(item);
  return {
    imageScalePct: value.imageScalePct as number,
    imageXStep: value.imageXStep as number,
    imageYStep: value.imageYStep as number,
    composition: value.composition as CoffeeAppearanceConfig["composition"],
    buttonLayout: value.buttonLayout as CoffeeAppearanceConfig["buttonLayout"],
    showStateMarker: value.showStateMarker as boolean,
    showAuthority: value.showAuthority as boolean,
    showImage: value.showImage as boolean
  };
}

export function planningDensityFor(item: OverviewLayoutItem): "comfortable" | "compact" {
  return normalizedConfigForItem(item).density as "comfortable" | "compact";
}

export function sourceOwnedCoffeeScale(configured: number, safeMaximum = 120): number {
  return Math.max(70, Math.min(safeMaximum, Math.round(configured / 5) * 5));
}

export function appearanceControlValueLabel(control: AppearanceControl, value: OverviewConfigValue): string {
  if (control.control === "integer_range") {
    if (control.key === "imageScalePct") return `${value}%`;
    if (control.key === "imageXStep") {
      return {
        "-3": "Левее",
        "-2": "Немного левее",
        "-1": "Слегка левее",
        "0": "По центру",
        "1": "Слегка правее",
        "2": "Немного правее",
        "3": "Правее"
      }[String(value)] ?? String(value);
    }
    if (control.key === "imageYStep") {
      return {
        "-2": "Выше",
        "-1": "Немного выше",
        "0": "По центру",
        "1": "Немного ниже",
        "2": "Ниже"
      }[String(value)] ?? String(value);
    }
    return `${value}`;
  }
  if (control.control === "boolean") return value ? "Включено" : "Выключено";
  return control.values.find((entry) => entry.value === value)?.label ?? String(value);
}

export function appearanceControlLabel(control: AppearanceControl): string {
  if (control.key === "showStateMarker") return "Показывать состояние";
  return control.label;
}

export function appearanceControlSection(widgetType: string, control: AppearanceControl): string {
  if (widgetType !== "home.coffee-machine") return control.section;
  if (["showImage", "imageScalePct", "imageXStep", "imageYStep"].includes(control.key)) return "Изображение";
  if (control.key === "composition") return "Композиция";
  if (["showStateMarker", "showAuthority"].includes(control.key)) return "Информация";
  return control.section;
}

export function appearanceControlsForPresentation(widgetType: string): readonly AppearanceControl[] {
  const controls = appearanceControlsFor(widgetType).filter((control) => control.key !== "showStateMarker");
  if (widgetType !== "home.coffee-machine") return controls;
  const order = ["showImage", "imageScalePct", "imageXStep", "imageYStep", "composition", "buttonLayout", "showAuthority"];
  return [...controls].sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key));
}

export function appearanceSchemaParityKeys(): Record<OverviewWidgetType | string, string[]> {
  return Object.fromEntries(Object.entries(overviewAppearanceSchemas).map(([widgetType, schema]) => [
    widgetType,
    schema.controls.map((control) => control.key)
  ]));
}
