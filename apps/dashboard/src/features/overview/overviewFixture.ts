import type { OverviewLayoutItem } from "@artem/contracts";

export type OverviewFixtureMode = "default" | "unknown" | "invalid" | "error";

const foundationLayout: readonly OverviewLayoutItem[] = [
  {
    instanceId: "fixture.rog",
    widgetType: "system.rog-g703-operational",
    sizeVariant: "standard",
    placement: { x: 0, y: 0, w: 12, h: 1 }
  },
  {
    instanceId: "fixture.coffee",
    widgetType: "home.coffee-machine",
    sizeVariant: "standard",
    placement: { x: 0, y: 2, w: 7, h: 4 }
  },
  {
    instanceId: "fixture.planning",
    widgetType: "planning.summary",
    sizeVariant: "standard",
    placement: { x: 7, y: 2, w: 5, h: 4 }
  },
  {
    instanceId: "fixture.quick-actions",
    widgetType: "home.quick-actions",
    sizeVariant: "standard",
    placement: { x: 0, y: 6, w: 7, h: 2 }
  },
  {
    instanceId: "fixture.health",
    widgetType: "system.health-summary",
    sizeVariant: "compact",
    placement: { x: 7, y: 6, w: 5, h: 2 }
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
  const layout = foundationLayout.map((item) => ({
    ...item,
    placement: { ...item.placement }
  }));

  if (mode === "unknown") {
    layout.push({
      instanceId: "fixture.unknown",
      widgetType: "future.untrusted-widget",
      sizeVariant: "standard",
      placement: { x: 0, y: 8, w: 7, h: 4 }
    });
  }

  if (mode === "error") {
    layout.push({
      instanceId: "fixture.throwing",
      widgetType: "planning.task-list",
      sizeVariant: "compact",
      placement: { x: 0, y: 8, w: 4, h: 3 }
    });
  }

  if (mode === "invalid") {
    layout.push({
      instanceId: "fixture.invalid",
      widgetType: "planning.task-list",
      sizeVariant: "compact",
      placement: { x: 0, y: 8, w: 6, h: 3 }
    });
  }

  return layout;
}
