import { describe, expect, it } from "vitest";
import { overviewFoundationLayout } from "./overviewFixture";
import {
  addOverviewWidget,
  createOverviewEditorState,
  makeShippedOverviewDocument,
  moveOverviewItem,
  overviewEditorDirty,
  overviewEditorReducer,
  overviewItemsEqual,
  removeOverviewWidget,
  resetOverviewItemConfig,
  resizeOverviewItem,
  setOverviewItemConfig
} from "./overviewEditorReducer";
import { projectOverviewLayout } from "./layoutValidation";

describe("Overview edit reducer", () => {
  it("enters with an in-memory clone and live state does not dirty it", () => {
    const state = createOverviewEditorState(makeShippedOverviewDocument(true));
    const editing = overviewEditorReducer(state, { type: "enter" });
    expect(editing.mode).toBe("editing");
    expect(editing.draft).not.toBe(editing.entrySnapshot?.items);
    expect(overviewEditorDirty(editing)).toBe(false);
    expect(overviewItemsEqual(editing.draft, editing.entrySnapshot!.items)).toBe(true);
  });

  it("moves by whole units and pushes collisions down only", () => {
    const items = overviewFoundationLayout();
    const result = moveOverviewItem(items, "fixture.planning", -5, 0);
    expect(result.ok).toBe(true);
    const moved = result.items.find((item) => item.instanceId === "fixture.planning");
    const coffee = result.items.find((item) => item.instanceId === "fixture.coffee");
    expect(moved?.placement.x).toBe(2);
    expect(moved?.placement.w).toBe(5);
    expect(coffee?.placement.x).toBe(0);
    expect(coffee?.placement.w).toBe(7);
    expect(coffee?.placement.y).toBe(5);
  });

  it("pushes every later collision down in stable order without lateral shuffle", () => {
    const result = moveOverviewItem(overviewFoundationLayout(), "fixture.planning", -5, 0);
    expect(result.ok).toBe(true);
    const coffee = result.items.find((item) => item.instanceId === "fixture.coffee")!;
    const quickActions = result.items.find((item) => item.instanceId === "fixture.quick-actions")!;
    expect(coffee.placement).toMatchObject({ x: 0, w: 7 });
    expect(quickActions.placement).toMatchObject({ x: 0, w: 7 });
    expect(quickActions.placement.y).toBeGreaterThan(coffee.placement.y);
  });

  it("rejects invalid movement and resize without mutating the draft", () => {
    const items = overviewFoundationLayout();
    const moved = moveOverviewItem(items, "fixture.coffee", -1, 0);
    expect(moved.ok).toBe(false);
    expect(moved.items).toEqual(items);
    const resized = resizeOverviewItem(items, "fixture.coffee", "detail");
    expect(resized.ok).toBe(false);
  });

  it("resizes a named variant and resolves collision at the anchored top-left", () => {
    const result = resizeOverviewItem(overviewFoundationLayout(), "fixture.coffee", "large");
    expect(result.ok).toBe(true);
    expect(result.items.find((item) => item.instanceId === "fixture.coffee")).toMatchObject({
      sizeVariant: "large",
      placement: { x: 0, y: 1, w: 8, h: 5 }
    });
    expect(result.items.find((item) => item.instanceId === "fixture.planning")?.placement.y).toBeGreaterThan(1);
  });

  it("adds first-fit, blocks visible singleton duplicates, hides, and restores identity", () => {
    const removed = removeOverviewWidget(overviewFoundationLayout(), "fixture.coffee");
    const restored = addOverviewWidget(removed, "home.coffee-machine");
    expect(restored.ok).toBe(true);
    expect(restored.items.filter((item) => item.widgetType === "home.coffee-machine")).toHaveLength(1);
    expect(restored.items.find((item) => item.widgetType === "home.coffee-machine")).toMatchObject({ instanceId: "fixture.coffee", visibility: "visible" });
    expect(addOverviewWidget(restored.items, "home.coffee-machine").ok).toBe(false);
  });

  it("tracks config dirty state, resets only one widget, and preserves config across resize", () => {
    const items = overviewFoundationLayout();
    const changed = setOverviewItemConfig(items, "fixture.coffee", "imageScalePct", 120);
    expect(changed.find((item) => item.instanceId === "fixture.coffee")?.config?.imageScalePct).toBe(120);
    const reset = resetOverviewItemConfig(changed, "fixture.coffee");
    expect(reset.find((item) => item.instanceId === "fixture.coffee")?.config?.imageScalePct).toBe(100);
    const resized = resizeOverviewItem(changed, "fixture.coffee", "compact");
    expect(resized.items.find((item) => item.instanceId === "fixture.coffee")?.config?.imageScalePct).toBe(120);
  });

  it("adds a new widget in deterministic first-fit without moving existing items", () => {
    const original = overviewFoundationLayout();
    const result = addOverviewWidget(original, "weather.alert");
    expect(result.ok).toBe(true);
    for (const originalItem of original) {
      expect(result.items.find((item) => item.instanceId === originalItem.instanceId)?.placement).toEqual(originalItem.placement);
    }
    expect(result.items.find((item) => item.widgetType === "weather.alert")?.placement).toEqual({ x: 0, y: 7, w: 6, h: 2 });
  });

  it("keeps appearance config through compact projection without changing the canonical draft", () => {
    const configured = setOverviewItemConfig(overviewFoundationLayout(), "fixture.coffee", "imageScalePct", 120);
    const before = configured.find((item) => item.instanceId === "fixture.coffee")?.config;
    const projection = projectOverviewLayout(configured, 640);
    expect(projection.profile.id).toBe("compact-4");
    expect(projection.items.find((item) => item.item.instanceId === "fixture.coffee")?.item.config).toEqual(before);
    expect(configured.find((item) => item.instanceId === "fixture.coffee")?.config).toEqual(before);
  });

  it("does not mark a draft dirty when only the live canonical revision changes", () => {
    const initial = createOverviewEditorState(makeShippedOverviewDocument(true));
    const editing = overviewEditorReducer(initial, { type: "enter" });
    const liveUpdate = {
      ...editing,
      canonical: { ...editing.canonical, revision: 8, updatedAt: "2026-08-14T12:00:00+00:00" }
    };
    expect(overviewEditorDirty(liveUpdate)).toBe(false);
  });

  it("reset and cancel have separate semantics", () => {
    const initial = createOverviewEditorState(makeShippedOverviewDocument(true));
    const editing = overviewEditorReducer(initial, { type: "enter" });
    const changed = overviewEditorReducer(editing, { type: "move", instanceId: "fixture.coffee", dx: 1, dy: 0 });
    expect(overviewEditorDirty(changed)).toBe(true);
    const reset = overviewEditorReducer(changed, { type: "reset" });
    expect(overviewEditorDirty(reset)).toBe(true);
    const cancelled = overviewEditorReducer(reset, { type: "cancel" });
    expect(cancelled.mode).toBe("normal");
    expect(cancelled.draft).toEqual(initial.canonical.items);
  });

  it("returns an explicit save failure to editing without changing the draft", () => {
    const initial = createOverviewEditorState(makeShippedOverviewDocument(true));
    const editing = overviewEditorReducer(initial, { type: "enter" });
    const changed = overviewEditorReducer(editing, {
      type: "set-config",
      instanceId: "fixture.coffee",
      key: "imageScalePct",
      value: 115
    });
    const saving = overviewEditorReducer(changed, { type: "save-started" });
    const failed = overviewEditorReducer(saving, { type: "save-failed", message: "Сервер отклонил конфигурацию панели." });

    expect(failed.mode).toBe("editing");
    expect(failed.draft).toEqual(saving.draft);
    expect(failed.entrySnapshot).toEqual(saving.entrySnapshot);
    expect(failed.selectedInstanceId).toBe(saving.selectedInstanceId);
    expect(failed.message).toBe("Сервер отклонил конфигурацию панели.");
    expect(failed.conflict).toBe(false);
    expect(overviewEditorDirty(failed)).toBe(true);
  });
});
