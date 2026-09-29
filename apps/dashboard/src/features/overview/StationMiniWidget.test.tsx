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
    vi.useRealTimers();
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
    const html = renderToStaticMarkup(<StationMiniWidget interactive />);
    const keyframes = css.slice(css.indexOf("@keyframes station-mini-widget-glow-pulse"), css.indexOf(".station-mini-widget__image"));
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .station-mini-widget__glow"));
    expect(html.match(/class="station-mini-widget__glow(?: station-mini-widget__glow--active)?"/g)).toHaveLength(1);
    expect(css).toMatch(/\.station-mini-widget__image\s*\{[^}]*object-fit:\s*contain;[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/\.station-mini-widget__glow\s*\{[^}]*z-index:\s*0;[^}]*width:\s*124px;[^}]*height:\s*124px;[^}]*rgba\(191, 126, 206, \.50\)[^}]*rgba\(162, 105, 194, \.24\)[^}]*filter:\s*blur\(20px\);[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/\.station-mini-widget__image\s*\{[^}]*z-index:\s*1;/s);
    expect(css).toMatch(/\.station-mini-widget__fallback\s*\{[^}]*z-index:\s*1;/s);
    expect(css).toMatch(/\.station-mini-widget__glow--active\s*\{\s*animation:\s*station-mini-widget-glow-pulse 1200ms both;/);
    expect(keyframes).toContain("33% {\n    opacity: .96;\n    transform: scale(1);");
    expect(keyframes).toContain("50% {\n    opacity: .92;");
    expect(keyframes).toContain("100% {\n    opacity: 0;\n    transform: scale(1.03);");
    expect(css).toMatch(/\.station-mini-widget__button\s*\{[^}]*min-width:\s*48px;[^}]*min-height:\s*48px;/s);
    expect(css).toMatch(/\.station-mini-widget__music\s*\{[^}]*min-height:\s*48px;/s);
    expect(reducedMotion).toContain(".station-mini-widget__glow {\n    animation: none;\n    transition: none;\n    transform: none;");
    expect(reducedMotion).toContain(".station-mini-widget__glow--active { opacity: .78; }");
  });

  it("starts immediately for accepted fixed actions, replays on the next press, and expires without stale timers", async () => {
    const actions = Object.fromEntries(STATION_ACTIONS.map((actionId) => [actionId, { allowed: true } ]));
    const actionCalls: Array<{ path: string; method?: string; body?: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/availability")) {
        return new Response(JSON.stringify({ schemaVersion: 1, actions }), { status: 200 });
      }
      const body = options?.body ? JSON.parse(String(options.body)) as Record<string, string> : undefined;
      actionCalls.push({ path, method: options?.method, body });
      return new Response(JSON.stringify({
        schemaVersion: 1,
        actionId: body?.actionId,
        requestId: body?.requestId,
        status: "dispatched"
      }), { status: 200 });
    }));
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root?.render(<StationMiniWidget interactive />); await Promise.resolve(); });
    const timersBeforePress = vi.getTimerCount();
    const play = host.querySelector<HTMLButtonElement>('button[aria-label="Play"]');
    const volumeUp = host.querySelector<HTMLButtonElement>('button[aria-label="Volume up"]');
    expect(play?.disabled).toBe(false);
    expect(volumeUp?.disabled).toBe(false);

    await act(async () => {
      play?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstGlow = host.querySelector(".station-mini-widget__glow");
    expect(host.querySelectorAll(".station-mini-widget__glow")).toHaveLength(1);
    expect(firstGlow?.classList.contains("station-mini-widget__glow--active")).toBe(true);
    expect(vi.getTimerCount()).toBe(timersBeforePress + 1);

    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(volumeUp?.disabled).toBe(false);
    await act(async () => {
      volumeUp?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const secondGlow = host.querySelector(".station-mini-widget__glow");
    expect(secondGlow).not.toBe(firstGlow);
    expect(host.querySelectorAll(".station-mini-widget__glow")).toHaveLength(1);
    expect(secondGlow?.classList.contains("station-mini-widget__glow--active")).toBe(true);
    expect(vi.getTimerCount()).toBe(timersBeforePress + 1);
    expect(actionCalls).toHaveLength(2);
    expect(actionCalls.map((call) => call.path)).toEqual([
      "/api/v1/actions/station", "/api/v1/actions/station"
    ]);
    expect(actionCalls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(actionCalls.map((call) => call.body?.actionId)).toEqual(["media.alice.play", "media.alice.volume_up"]);
    for (const call of actionCalls) {
      expect(Object.keys(call.body ?? {}).sort()).toEqual(["actionId", "requestId"]);
      expect(call.body?.requestId).toBeTruthy();
    }
    expect(host.textContent).toContain("Команда отправлена");

    await act(async () => { await vi.advanceTimersByTimeAsync(1199); });
    expect(host.querySelector(".station-mini-widget__glow--active")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(host.querySelector(".station-mini-widget__glow--active")).toBeNull();
    expect(vi.getTimerCount()).toBe(timersBeforePress);

    await act(async () => { play?.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector(".station-mini-widget__glow--active")).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(timersBeforePress);
  });
});
