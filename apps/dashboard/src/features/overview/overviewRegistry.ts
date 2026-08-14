import type {
  OverviewWidgetSize,
  OverviewWidgetSizeVariant,
  OverviewWidgetType
} from "@artem/contracts";
import type { IconName } from "../../icons";
import { appearanceSchemaFor, type AppearanceSchema } from "./appearanceConfig";

export type OverviewWidgetCategory = "Управление" | "Планирование" | "Дом" | "Состояние" | "Контекст";

export interface OverviewWidgetDefinition {
  readonly widgetType: OverviewWidgetType;
  readonly title: string;
  readonly category: OverviewWidgetCategory;
  readonly iconKey: IconName;
  readonly singleton: boolean;
  readonly minW: number;
  readonly minH: number;
  readonly maxW: number;
  readonly maxH: number;
  readonly defaultSizeVariant: OverviewWidgetSizeVariant;
  readonly sizes: Readonly<Partial<Record<OverviewWidgetSizeVariant, OverviewWidgetSize>>>;
  readonly fixtureCopy: string;
  readonly appearanceSchema: AppearanceSchema;
}

function definition(
  value: Omit<OverviewWidgetDefinition, "appearanceSchema">
): OverviewWidgetDefinition {
  return { ...value, appearanceSchema: appearanceSchemaFor(value.widgetType) };
}

/**
 * Fixed, source-owned Overview vocabulary. Layout data can select one of
 * these keys, but it cannot provide a renderer, URL, action, or binding.
 */
export const overviewWidgetRegistry: readonly OverviewWidgetDefinition[] = [
  definition({
    widgetType: "home.coffee-machine",
    title: "Кофемашина",
    category: "Дом",
    iconKey: "home",
    singleton: true,
    minW: 4,
    minH: 3,
    maxW: 8,
    maxH: 5,
    defaultSizeVariant: "standard",
    sizes: {
      compact: { w: 4, h: 3 },
      standard: { w: 7, h: 4 },
      large: { w: 8, h: 5 }
    },
    fixtureCopy: "Структурный слот состояния и безопасного действия."
  }),
  definition({
    widgetType: "system.rog-g703-operational",
    title: "ASUS ROG G703GI",
    category: "Управление",
    iconKey: "system",
    singleton: true,
    minW: 6,
    minH: 1,
    maxW: 12,
    maxH: 2,
    defaultSizeVariant: "standard",
    sizes: {
      compact: { w: 6, h: 1 },
      standard: { w: 12, h: 1 },
      detail: { w: 6, h: 2 }
    },
    fixtureCopy: "Структурный слот операционного состояния."
  }),
  definition({
    widgetType: "planning.summary",
    title: "Планирование",
    category: "Планирование",
    iconKey: "calendar",
    singleton: true,
    minW: 4,
    minH: 3,
    maxW: 7,
    maxH: 5,
    defaultSizeVariant: "standard",
    sizes: {
      compact: { w: 4, h: 3 },
      standard: { w: 5, h: 4 },
      large: { w: 7, h: 5 }
    },
    fixtureCopy: "Структурный слот ближайших дел без фиктивных счётчиков."
  }),
  definition({
    widgetType: "home.quick-actions",
    title: "Быстрые действия дома",
    category: "Дом",
    iconKey: "home",
    singleton: true,
    minW: 4,
    minH: 2,
    maxW: 7,
    maxH: 2,
    defaultSizeVariant: "standard",
    sizes: {
      compact: { w: 4, h: 2 },
      standard: { w: 7, h: 2 }
    },
    fixtureCopy: "Структурный слот будущих локальных действий."
  }),
  definition({
    widgetType: "system.health-summary",
    title: "Состояние сервисов",
    category: "Состояние",
    iconKey: "services",
    singleton: true,
    minW: 5,
    minH: 2,
    maxW: 7,
    maxH: 3,
    defaultSizeVariant: "compact",
    sizes: {
      compact: { w: 5, h: 2 },
      large: { w: 7, h: 3 }
    },
    fixtureCopy: "Структурный слот агрегированного состояния."
  }),
  definition({
    widgetType: "weather.alert",
    title: "Погодное предупреждение",
    category: "Контекст",
    iconKey: "weather",
    singleton: true,
    minW: 4,
    minH: 1,
    maxW: 6,
    maxH: 2,
    defaultSizeVariant: "standard",
    sizes: {
      compact: { w: 4, h: 1 },
      standard: { w: 6, h: 2 }
    },
    fixtureCopy: "Структурный слот для значимого предупреждения."
  }),
  definition({
    widgetType: "planning.calendar-agenda",
    title: "Повестка календаря",
    category: "Планирование",
    iconKey: "calendar",
    singleton: true,
    minW: 4,
    minH: 3,
    maxW: 8,
    maxH: 5,
    defaultSizeVariant: "standard",
    sizes: {
      compact: { w: 4, h: 3 },
      standard: { w: 6, h: 4 },
      large: { w: 8, h: 5 }
    },
    fixtureCopy: "Структурный слот read-only повестки."
  }),
  definition({
    widgetType: "planning.task-list",
    title: "Список задач",
    category: "Планирование",
    iconKey: "tasks",
    singleton: true,
    minW: 4,
    minH: 3,
    maxW: 8,
    maxH: 5,
    defaultSizeVariant: "standard",
    sizes: {
      compact: { w: 4, h: 3 },
      standard: { w: 6, h: 4 },
      large: { w: 8, h: 5 }
    },
    fixtureCopy: "Структурный слот read-only списка задач."
  })
] as const;

const overviewWidgetMap = new Map<string, OverviewWidgetDefinition>(
  overviewWidgetRegistry.map((widget) => [widget.widgetType, widget])
);

export function getOverviewWidgetDefinition(widgetType: string): OverviewWidgetDefinition | null {
  return overviewWidgetMap.get(widgetType) ?? null;
}

export function resolveOverviewWidgetSize(
  widget: OverviewWidgetDefinition,
  sizeVariant: string
): OverviewWidgetSize | null {
  const size = widget.sizes[sizeVariant as OverviewWidgetSizeVariant];
  return size ? { ...size } : null;
}
