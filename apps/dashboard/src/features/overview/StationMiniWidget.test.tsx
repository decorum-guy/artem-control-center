// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWidgetAsset } from "../../widgetAssets";
import { STATION_ACTIONS } from "../../stationActionsApi";
import { StationMiniWidget } from "./StationMiniWidget";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Station Mini 2 Overview widget", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.unstubAllGlobals();
  });

  it("resolves the canonical Station asset through the bounded local asset registry", () => {
    const resolved = resolveWidgetAsset("./assets/widgets/station-mini-2.png");
    expect(resolved).toBeTruthy();
    expect(resolved).toContain("station-mini-2.png");
    expect(resolveWidgetAsset("https://example.invalid/station-mini-2.png")).toBeNull();

    const html = renderToStaticMarkup(<StationMiniWidget interactive />);
    expect(html).toContain(`src="${resolved}"`);
    expect(html).toContain('data-testid="station-artwork-slot"');
    expect(html).toContain('class="station-mini-widget__image"');
    expect(html).not.toContain("station-mini-widget__fallback");
  });

  it("shows the existing SVG fallback after the browser reports an image load failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, actions: {} }), { status: 200 })));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<StationMiniWidget interactive />);
      await Promise.resolve();
    });
    const image = host.querySelector<HTMLImageElement>(".station-mini-widget__image");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toBe(resolveWidgetAsset("./assets/widgets/station-mini-2.png"));
    expect(host.querySelector("[data-testid=station-artwork-slot] button")).toBeNull();

    await act(async () => { image?.dispatchEvent(new Event("error")); });
    expect(host.querySelector(".station-mini-widget__image")).toBeNull();
    expect(host.querySelector(".station-mini-widget__fallback")).not.toBeNull();
  });

  it("keeps all seven typed controls, the Music action, and edit-mode non-interactivity", () => {
    const html = renderToStaticMarkup(<StationMiniWidget interactive={false} />);
    for (const label of ["Play", "Pause", "Volume down", "Volume up", "Previous track", "Next track", "Like current track"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(STATION_ACTIONS).toHaveLength(7);
    expect(html.match(/<button[^>]*aria-label=/g)).toHaveLength(7);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(8);
    expect(html).toContain("Музыка");
    expect(html).toContain("station-artwork-slot");
    expect(html).not.toMatch(/volume level|progress|album artwork|now playing|текущий трек|громкость:/i);
  });

  it("keeps artwork contained and behind the transient glow while preserving touch and motion rules", () => {
    const css = readFileSync("src/features/overview/overviewWidgets.css", "utf8");
    expect(css).toMatch(/\.station-mini-widget__image\s*\{[^}]*object-fit:\s*contain;[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/\.station-mini-widget__glow\s*\{[^}]*z-index:\s*0;/s);
    expect(css).toMatch(/\.station-mini-widget__image\s*\{[^}]*z-index:\s*1;/s);
    expect(css).toMatch(/\.station-mini-widget__fallback\s*\{[^}]*z-index:\s*1;/s);
    expect(css).toMatch(/\.station-mini-widget__button\s*\{[^}]*min-width:\s*48px;[^}]*min-height:\s*48px;/s);
    expect(css).toMatch(/\.station-mini-widget__music\s*\{[^}]*min-height:\s*48px;/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*\.station-mini-widget__glow\s*\{\s*transition:\s*none;\s*transform:\s*none;/s);
  });
});
