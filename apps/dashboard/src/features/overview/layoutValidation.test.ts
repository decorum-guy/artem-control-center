import { describe, expect, it } from "vitest";
import type { OverviewLayoutItem, OverviewWidgetPlacement } from "@artem/contracts";
import { overviewFoundationLayout } from "./overviewFixture";
import {
  findFirstFit,
  profileForWorkspaceWidth,
  projectOverviewLayout,
  pushDownPlacement,
  rectanglesOverlap,
  resolvePushDown,
  sortCanonicalLayoutItems,
  validateOverviewLayout
} from "./layoutValidation";
import { getOverviewWidgetDefinition, resolveOverviewWidgetSize } from "./overviewRegistry";

function item(
  instanceId: string,
  widgetType = "home.coffee-machine",
  sizeVariant = "standard",
  placement: OverviewWidgetPlacement = { x: 0, y: 0, w: 7, h: 4 }
): OverviewLayoutItem {
  return { instanceId, widgetType, sizeVariant, placement };
}

function expectInvalidProjection(
  projection: ReturnType<typeof projectOverviewLayout>,
  canonicalIndex: number
): void {
  const projected = projection.items.find((entry) => entry.canonicalIndex === canonicalIndex);
  expect(projected).toBeDefined();
  expect(projected?.state).toBe("fallback");
  expect(projected?.fallbackReason).toBe("invalid-layout");
  expect(projected?.definition).not.toBeNull();
}

describe("Overview V2 placement validation", () => {
  it("accepts the neutral canonical foundation fixture", () => {
    const result = validateOverviewLayout(overviewFoundationLayout());
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it.each([
    ["x < 0", { x: -1, y: 0, w: 7, h: 4 }, "negative-x"],
    ["y < 0", { x: 0, y: -1, w: 7, h: 4 }, "negative-y"],
    ["fractional units", { x: 0.5, y: 0, w: 7, h: 4 }, "invalid-integer"],
    ["zero width", { x: 0, y: 0, w: 0, h: 4 }, "invalid-width"],
    ["negative height", { x: 0, y: 0, w: 7, h: -1 }, "invalid-height"],
    ["column overflow", { x: 6, y: 0, w: 7, h: 4 }, "column-overflow"]
  ])("rejects %s", (_label, placement, code) => {
    const result = validateOverviewLayout([item("invalid", "home.coffee-machine", "standard", placement)]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  });

  it("enforces registered minimum, maximum and named variant dimensions", () => {
    expect(validateOverviewLayout([
      item("small", "home.coffee-machine", "compact", { x: 0, y: 0, w: 3, h: 3 })
    ]).issues.map((issue) => issue.code)).toContain("minimum-size");
    expect(validateOverviewLayout([
      item("large", "home.coffee-machine", "large", { x: 0, y: 0, w: 9, h: 5 })
    ]).issues.map((issue) => issue.code)).toContain("maximum-size");
    expect(validateOverviewLayout([
      item("mismatch", "home.coffee-machine", "compact", { x: 0, y: 0, w: 7, h: 4 })
    ]).issues.map((issue) => issue.code)).toContain("variant-dimension-mismatch");
    expect(resolveOverviewWidgetSize(getOverviewWidgetDefinition("home.coffee-machine")!, "standard"))
      .toEqual({ w: 7, h: 4 });
  });

  it("rejects duplicate instance IDs and singleton definitions", () => {
    const result = validateOverviewLayout([
      item("same"),
      item("same", "home.quick-actions", "standard", { x: 0, y: 4, w: 7, h: 2 }),
      item("coffee-again", "home.coffee-machine", "compact", { x: 7, y: 0, w: 4, h: 3 })
    ]);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "duplicate-instance-id",
      "duplicate-singleton"
    ]));
  });

  it("detects overlap while treating touching edges as safe", () => {
    expect(rectanglesOverlap(
      { x: 0, y: 0, w: 3, h: 1 },
      { x: 3, y: 0, w: 3, h: 1 }
    )).toBe(false);
    const result = validateOverviewLayout([
      item("first", "home.quick-actions", "compact", { x: 0, y: 0, w: 4, h: 2 }),
      item("second", "home.quick-actions", "compact", { x: 2, y: 1, w: 4, h: 2 })
    ]);
    expect(result.issues.map((issue) => issue.code)).toContain("overlap");
  });

  it("classifies unknown widget types without treating them as generic services", () => {
    const result = validateOverviewLayout([item("unknown", "future.untrusted-widget")]);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown-widget-type", widgetType: "future.untrusted-widget" })
    ]));
    const projection = projectOverviewLayout([item("unknown", "future.untrusted-widget")], 1280);
    expect(projection.items[0]).toMatchObject({
      canonicalIndex: 0,
      state: "fallback",
      fallbackReason: "unknown",
      definition: null
    });
  });
});

describe("Overview V2 trusted-render eligibility", () => {
  it("never renders either record when instance IDs are duplicated", () => {
    const projection = projectOverviewLayout([
      item("same"),
      item("same", "home.quick-actions", "standard", { x: 0, y: 4, w: 7, h: 2 })
    ], 1280);
    expectInvalidProjection(projection, 0);
    expectInvalidProjection(projection, 1);
  });

  it("never renders either record when a singleton is duplicated", () => {
    const projection = projectOverviewLayout([
      item("coffee-one"),
      item("coffee-two", "home.coffee-machine", "standard", { x: 0, y: 4, w: 7, h: 4 })
    ], 1280);
    expectInvalidProjection(projection, 0);
    expectInvalidProjection(projection, 1);
  });

  it("never renders either record when canonical rectangles overlap", () => {
    const projection = projectOverviewLayout([
      item("coffee", "home.coffee-machine", "standard", { x: 0, y: 0, w: 7, h: 4 }),
      item("planning", "planning.summary", "standard", { x: 4, y: 0, w: 5, h: 4 })
    ], 1280);
    expectInvalidProjection(projection, 0);
    expectInvalidProjection(projection, 1);
  });

  it.each([
    ["negative coordinate", item("negative", "home.coffee-machine", "standard", { x: -1, y: 0, w: 7, h: 4 })],
    ["out-of-bounds coordinate", item("overflow", "planning.summary", "standard", { x: 8, y: 0, w: 5, h: 4 })],
    ["variant dimension mismatch", item("mismatch", "home.coffee-machine", "compact", { x: 0, y: 0, w: 7, h: 4 })],
    ["unknown size variant", item("unknown-size", "home.coffee-machine", "future", { x: 0, y: 0, w: 7, h: 4 })],
    ["minimum size violation", item("too-small", "home.coffee-machine", "compact", { x: 0, y: 0, w: 3, h: 3 })],
    ["maximum size violation", item("too-large", "home.coffee-machine", "large", { x: 0, y: 0, w: 9, h: 5 })]
  ])("does not trust a known widget with %s", (_label, invalidItem) => {
    const projection = projectOverviewLayout([invalidItem], 719);
    expectInvalidProjection(projection, 0);
  });

  it("still renders a valid known record while isolating an invalid sibling", () => {
    const projection = projectOverviewLayout([
      item("valid", "home.coffee-machine", "standard", { x: 0, y: 0, w: 7, h: 4 }),
      item("invalid", "planning.task-list", "compact", { x: 0, y: 8, w: 6, h: 3 })
    ], 1280);
    expect(projection.items.find((entry) => entry.canonicalIndex === 0)).toMatchObject({ state: "rendered" });
    expectInvalidProjection(projection, 1);
  });
});

describe("Overview V2 deterministic collision helpers", () => {
  it("uses row-major first-fit and appends below a full occupied row", () => {
    expect(findFirstFit(
      { w: 1, h: 1 },
      [{ x: 0, y: 0, w: 1, h: 1 }, { x: 2, y: 0, w: 1, h: 1 }],
      4
    )).toEqual({ x: 1, y: 0, w: 1, h: 1 });
    expect(findFirstFit(
      { w: 2, h: 1 },
      [{ x: 0, y: 0, w: 4, h: 1 }],
      4
    )).toEqual({ x: 0, y: 1, w: 2, h: 1 });
  });

  it("pushes down while retaining x, width and height", () => {
    const proposed = { x: 1, y: 0, w: 2, h: 1 };
    const resolved = pushDownPlacement(proposed, [{ x: 0, y: 0, w: 4, h: 1 }]);
    expect(resolved).toEqual({ x: 1, y: 1, w: 2, h: 1 });
  });

  it("resolves multiple collisions in stable input order without lateral shuffling", () => {
    expect(resolvePushDown([
      { x: 0, y: 0, w: 4, h: 1 },
      { x: 1, y: 0, w: 2, h: 1 },
      { x: 2, y: 0, w: 2, h: 1 }
    ])).toEqual([
      { x: 0, y: 0, w: 4, h: 1 },
      { x: 1, y: 1, w: 2, h: 1 },
      { x: 2, y: 2, w: 2, h: 1 }
    ]);
  });
});

describe("Overview V2 responsive projection", () => {
  it("uses the exact 12/8/4 breakpoint profiles", () => {
    expect(profileForWorkspaceWidth(960)).toMatchObject({ id: "landscape-12", columns: 12, rowHeight: 60, gap: 12 });
    expect(profileForWorkspaceWidth(959)).toMatchObject({ id: "medium-8", columns: 8, rowHeight: 64, gap: 12 });
    expect(profileForWorkspaceWidth(720)).toMatchObject({ id: "medium-8", columns: 8, rowHeight: 64, gap: 12 });
    expect(profileForWorkspaceWidth(719)).toMatchObject({ id: "compact-4", columns: 4, rowHeight: "auto", gap: 10 });
  });

  it("preserves canonical input while projecting into 8 and 4 columns", () => {
    const canonical = overviewFoundationLayout();
    const before = JSON.stringify(canonical);
    const landscape = projectOverviewLayout(canonical, 1280);
    const medium = projectOverviewLayout(canonical, 959);
    const compact = projectOverviewLayout(canonical, 719);
    expect(JSON.stringify(canonical)).toBe(before);
    expect(landscape.items.find((entry) => entry.item.instanceId === "fixture.coffee")?.placement)
      .toEqual({ x: 0, y: 2, w: 7, h: 4 });
    expect(medium.profile.columns).toBe(8);
    expect(compact.profile.columns).toBe(4);
    for (const projection of [medium, compact]) {
      for (const projected of projection.items) {
        expect(projected.placement.x).toBeGreaterThanOrEqual(0);
        expect(projected.placement.x + projected.placement.w).toBeLessThanOrEqual(projection.profile.columns);
      }
      for (let index = 0; index < projection.items.length; index += 1) {
        for (let next = index + 1; next < projection.items.length; next += 1) {
          expect(rectanglesOverlap(projection.items[index].placement, projection.items[next].placement)).toBe(false);
        }
      }
    }
  });

  it("selects compact registered variants and keeps canonical reading order", () => {
    const projection = projectOverviewLayout(overviewFoundationLayout(), 719);
    expect(projection.items.map((entry) => entry.item.instanceId)).toEqual([
      "fixture.rog",
      "fixture.coffee",
      "fixture.planning",
      "fixture.quick-actions",
      "fixture.health"
    ]);
    expect(projection.items.find((entry) => entry.item.instanceId === "fixture.coffee")?.sizeVariant).toBe("compact");
    expect(projection.items.find((entry) => entry.item.instanceId === "fixture.planning")?.sizeVariant).toBe("compact");
  });

  it("returns a bounded deterministic fallback for unsupported profile sizes", () => {
    const projection = projectOverviewLayout([item(
      "rog",
      "system.rog-g703-operational",
      "standard",
      { x: 0, y: 0, w: 12, h: 1 }
    )], 719);
    expect(projection.items[0]).toMatchObject({
      state: "fallback",
      fallbackReason: "unsupported-profile",
      placement: { x: 0, y: 0, w: 3, h: 1 }
    });
    expect(projection.issues.map((issue) => issue.code)).toContain("responsive-unsupported");
  });

  it("produces byte-equivalent output for identical input", () => {
    const canonical = overviewFoundationLayout();
    expect(JSON.stringify(projectOverviewLayout(canonical, 959)))
      .toBe(JSON.stringify(projectOverviewLayout(canonical, 959)));
    expect(sortCanonicalLayoutItems(canonical)).toEqual(sortCanonicalLayoutItems(canonical));
  });
});
