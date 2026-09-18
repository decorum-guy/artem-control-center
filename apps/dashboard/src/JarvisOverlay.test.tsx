// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionLockProvider } from "./InteractionLock";
import { JarvisOverlay } from "./JarvisOverlay";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const disabled = { schemaVersion: "jarvis.voice.v1", enabled: false, configured: false, health: "disabled", state: "disabled", sequence: 0,
  recognizedText: null, responseText: null, safeErrorCode: null, wakeLatencyMs: null, sttLatencyMs: null };

describe("JarvisOverlay voice foundation", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove(); root = null; host = null;
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  async function mount(voice: () => object) {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/voice/state")) return Promise.resolve(new Response(JSON.stringify(voice()), { status: 200 }));
      if (String(input).endsWith("/interaction-lock")) return Promise.resolve(new Response(null, { status: 204 }));
      if (String(input).endsWith("/jarvis/turn")) return Promise.resolve(new Response(JSON.stringify({ schemaVersion: "jarvis.turn.v1", status: "ready", intentId: "system.time.current", responseText: "Сейчас 12:34.", navigation: null }), { status: 200 }));
      return Promise.reject(new Error("unexpected endpoint"));
    });
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => {
      root?.render(<InteractionLockProvider><JarvisOverlay onNavigate={() => undefined} /></InteractionLockProvider>);
      await Promise.resolve(); await Promise.resolve();
    });
    return fetchMock;
  }

  it("retains typed A1 when voice is disabled", async () => {
    await mount(() => disabled);
    const launcher = host?.querySelector<HTMLButtonElement>("[data-testid=jarvis-launcher]");
    await act(async () => launcher?.click());
    const input = host?.querySelector<HTMLInputElement>("#jarvis-text");
    await act(async () => {
      if (!input) throw new Error("missing typed input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Который час?");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(host?.textContent).toContain("Сейчас 12:34.");
  });

  it("auto-opens for voice state and renders transcript as inert text", async () => {
    vi.useFakeTimers();
    let voice: object = disabled;
    await mount(() => voice);
    voice = { ...disabled, enabled: true, configured: true, health: "healthy", state: "wake_detected", sequence: 1 };
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(host?.querySelector("[data-testid=jarvis-panel]")).not.toBeNull();
    expect(host?.textContent).toContain("Слушаю");
    voice = { ...disabled, enabled: true, configured: true, health: "healthy", state: "ready", sequence: 2,
      recognizedText: "<img src=x onerror=alert(1)>", responseText: "Готово." };
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(host?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(host?.querySelector("img")).toBeNull();
    expect(host?.textContent).toContain("Готово.");
  });
});
