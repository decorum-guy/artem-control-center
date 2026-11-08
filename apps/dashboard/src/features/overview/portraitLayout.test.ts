// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverviewLayoutItem } from "@artem/contracts";
import { overviewWidgetRegistry } from "./overviewRegistry";
import { projectOverviewLayout, validateOverviewLayout, sortCanonicalLayoutItems } from "./layoutValidation";
import { createOverviewEditorState, makeShippedOverviewDocument, overviewEditorReducer } from "./overviewEditorReducer";
import { getOverviewLayout, saveOverviewLayout } from "./overviewLayoutApi";

afterEach(() => vi.unstubAllGlobals());
describe("independent portrait profile", () => {
  it.each([540, 688, 736, 1048])("renders every registered variant at workspace %s without losing logical geometry", (width) => {
    for (const definition of overviewWidgetRegistry) for (const [variant, size] of Object.entries(definition.sizes)) {
      const items: OverviewLayoutItem[] = [{ instanceId: "owner.widget", widgetType: definition.widgetType, placement: { x: 0, y: 0, ...size }, sizeVariant: variant }];
      const before = JSON.stringify(items);
      const portrait = projectOverviewLayout(items, width, true);
      expect(portrait.items).toHaveLength(1);
      expect(portrait.items[0]).toMatchObject({ state: "rendered", sizeVariant: variant });
      expect(portrait.items[0].placement.w).toBeLessThanOrEqual(portrait.profile.columns);
      expect(JSON.stringify(items)).toBe(before);
      expect(projectOverviewLayout(items, 1064).items[0].placement).toEqual(items[0].placement);
    }
  });
  it("reorders a draft on the logical canvas and cancel restores landscape bytes", () => {
    const canonical = makeShippedOverviewDocument(true);
    const before = JSON.stringify(canonical);
    let state = createOverviewEditorState(canonical);
    state = overviewEditorReducer(state, { type: "enter" });
    const first = sortCanonicalLayoutItems(state.draft)[0].instanceId;
    state = overviewEditorReducer(state, { type: "reorder", instanceId: first, direction: 1 });
    expect(sortCanonicalLayoutItems(state.draft)[1].instanceId).toBe(first);
    expect(validateOverviewLayout(state.draft).valid).toBe(true);
    expect(JSON.stringify(canonical)).toBe(before);
    state = overviewEditorReducer(state, { type: "cancel" });
    expect(state.canonical).toEqual(canonical);
  });
  it("reads and explicitly saves only the fixed portrait resource with versioned envelope", async () => {
    const document = makeShippedOverviewDocument(true);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "overview.portrait.v1", profile: "portrait", layout: document }), { headers: { ETag: '"0"' } }));
    vi.stubGlobal("fetch", fetchMock);
    const read = await getOverviewLayout(undefined, "portrait");
    expect(read.document.items).toEqual(document.items);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "overview.portrait.v1", profile: "portrait", layout: { ...document, revision: 1 } })));
    await saveOverviewLayout(document.items, read.etag, undefined, "portrait");
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([["/api/v1/overview/layout/portrait", "GET"], ["/api/v1/overview/layout/portrait", "PATCH"]]);
    expect(fetchMock.mock.calls[1][1].headers["If-Match"]).toBe('"0"');
  });
  it("rejects a mismatched profile envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(makeShippedOverviewDocument(true)))));
    await expect(getOverviewLayout(undefined, "portrait")).rejects.toThrow("Не удалось загрузить");
  });
});
