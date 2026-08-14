import type { OverviewLayoutItem } from "@artem/contracts";
import { normalizeLayoutItems } from "./appearanceConfig";

export type OverviewFixtureMode = "default" | "unknown" | "invalid" | "error";

const foundationLayout: readonly OverviewLayoutItem[] = [
  {
    instanceId: "fixture.rog",
    widgetType: "system.rog-g703-operational",
    sizeVariant: "standard",
    placement: { x: 0, y: 0, w: 12, h: 1 },
    visibility: "visible"
  },
  {
    instanceId: "fixture.coffee",
    widgetType: "home.coffee-machine",
    sizeVariant: "standard",
    placement: { x: 0, y: 1, w: 7, h: 4 },
    visibility: "visible"
  },
  {
    instanceId: "fixture.planning",
    widgetType: "planning.summary",
    sizeVariant: "standard",
    placement: { x: 7, y: 1, w: 5, h: 4 },
    visibility: "visible"
  },
  {
    instanceId: "fixture.quick-actions",
    widgetType: "home.quick-actions",
    sizeVariant: "standard",
    placement: { x: 0, y: 5, w: 7, h: 2 },
    visibility: "visible"
  },
  {
    instanceId: "fixture.health",
    widgetType: "system.health-summary",
    sizeVariant: "compact",
    placement: { x: 7, y: 5, w: 5, h: 2 },
    visibility: "visible"
  }
];

export function overviewFixtureModeFromLocation(): OverviewFixtureMode {
  if (!import.meta.env.DEV) return "default";
  const value = new URLSearchParams(window.location.search).get("overviewFixture");
  return value === "unknown" || value === "invalid" || value === "error" ? value : "default";
}

export function overviewFoundationLayout(
  mode: OverviewFixtureMode = "default"
): readonly OverviewLayoutItem[] {
  const layout = normalizeLayoutItems(foundationLayout).map((item) => ({
    ...item,
    placement: { ...item.placement }
  }));

  if (mode === "unknown") {
    layout.push({
      instanceId: "fixture.unknown",
      widgetType: "future.untrusted-widget",
      sizeVariant: "standard",
      placement: { x: 0, y: 8, w: 7, h: 4 },
      visibility: "visible",
      config: {}
    });
  }

  if (mode === "error") {
    layout.push({
      instanceId: "fixture.throwing",
      widgetType: "planning.task-list",
      sizeVariant: "compact",
      placement: { x: 0, y: 8, w: 4, h: 3 },
      visibility: "visible",
      config: {}
    });
  }

  if (mode === "invalid") {
    layout.push({
      instanceId: "fixture.invalid",
      widgetType: "planning.task-list",
      sizeVariant: "compact",
      placement: { x: 0, y: 8, w: 6, h: 3 },
      visibility: "visible",
      config: {}
    });
  }

  return layout;
}
