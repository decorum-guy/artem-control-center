// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionLockProvider } from "./InteractionLock";
import { JarvisOverlay } from "./JarvisOverlay";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const disabled = { schemaVersion: "jarvis.voice.v1", enabled: false, configured: false, health: "disabled", state: "disabled", sequence: 0,
  recognizedText: null, responseText: null, safeErrorCode: null, wakeLatencyMs: null, sttLatencyMs: null, navigation: null, inputLevel: null };

describe("JarvisOverlay voice foundation", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove(); root = null; host = null;
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  async function mount(voice: () => object, onNavigate = () => undefined) {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/voice/state")) return Promise.resolve(new Response(JSON.stringify(voice()), { status: 200 }));
      if (String(input).endsWith("/interaction-lock")) return Promise.resolve(new Response(null, { status: 204 }));
      if (String(input).endsWith("/jarvis/turn")) return Promise.resolve(new Response(JSON.stringify({ schemaVersion: "jarvis.turn.v1", status: "ready", intentId: "system.time.current", responseText: "Сейчас 12:34.", navigation: null }), { status: 200 }));
      return Promise.reject(new Error("unexpected endpoint"));
    });
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => {
      root?.render(<InteractionLockProvider><JarvisOverlay onNavigate={onNavigate} /></InteractionLockProvider>);
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

  it("shows compact mic-reactive voice HUD without auto-opening the full panel", async () => {
    vi.useFakeTimers();
    let voice: object = disabled;
    await mount(() => voice);
    voice = { ...disabled, enabled: true, configured: true, health: "healthy", state: "wake_detected", sequence: 1, inputLevel: 0 };
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(host?.querySelector("[data-testid=jarvis-panel]")).toBeNull();
    expect(host?.querySelector("[data-testid=jarvis-voice-hud]")).not.toBeNull();
    expect(host?.textContent).toContain("Слушаю");

    voice = { ...voice, state: "listening", sequence: 2, inputLevel: 0.72 };
    await act(async () => { await vi.advanceTimersByTimeAsync(140); });
    expect(host?.querySelector("[data-testid=jarvis-launcher]")?.getAttribute("data-input-level")).toBe("0.720");

    voice = { ...voice, state: "submitting", sequence: 3, inputLevel: null,
      recognizedText: "<img src=x onerror=alert(1)>" };
    await act(async () => { await vi.advanceTimersByTimeAsync(140); });
    expect(host?.querySelector("[data-testid=jarvis-voice-transcript]")?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(host?.querySelector("img")).toBeNull();
  });

  it("cancels an active voice HUD without opening the full panel", async () => {
    vi.useFakeTimers();
    let voice: object = disabled;
    const fetchMock = await mount(() => voice);
    voice = { ...disabled, enabled: true, configured: true, health: "healthy", state: "listening", sequence: 1, inputLevel: 0.4 };
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });

    const cancel = host?.querySelector<HTMLButtonElement>("[data-testid=jarvis-voice-cancel]");
    expect(cancel).not.toBeNull();
    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });
    expect(host?.querySelector("[data-testid=jarvis-voice-hud]")).toBeNull();

    const lockWrites = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/interaction-lock"));
    const lastRequest = lockWrites.at(-1)?.[1] as RequestInit | undefined;
    expect(lastRequest?.body).toBe(JSON.stringify({ locked: true }));

    voice = { ...disabled, enabled: true, configured: true, health: "healthy", state: "idle", sequence: 2, inputLevel: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(140); await Promise.resolve(); });
    const afterIdle = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/interaction-lock"));
    const unlockRequest = afterIdle.at(-1)?.[1] as RequestInit | undefined;
    expect(unlockRequest?.body).toBe(JSON.stringify({ locked: false }));
  });

  it("passes canonical voice navigation through the existing callback", async () => {
    vi.useFakeTimers();
    let voice: object = disabled;
    const onNavigate = vi.fn();
    await mount(() => voice, onNavigate);
    voice = { ...disabled, enabled: true, configured: true, health: "healthy", state: "ready", sequence: 1,
      recognizedText: "Открой настройки", responseText: "Открываю раздел.", navigation: "/settings" };
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(onNavigate).toHaveBeenCalledWith("/settings");
    expect(host?.querySelector("[data-testid=jarvis-panel]")).toBeNull();
  });

  it("renders speaking without emitting a duplicate message before READY", async () => {
    vi.useFakeTimers();
    let voice: object = disabled;
    await mount(() => voice);
    voice = { ...disabled, enabled: true, configured: true, health: "healthy", state: "speaking", sequence: 1,
      recognizedText: "Открой настройки", responseText: "Открываю раздел." };
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(host?.textContent).toContain("Говорю");
    expect(host?.querySelector("[data-testid=jarvis-voice-hud]")?.textContent).toContain("Открываю раздел.");
    voice = { ...voice, state: "ready", sequence: 2 };
    await act(async () => { await vi.advanceTimersByTimeAsync(140); });
    expect(host?.textContent).toContain("Открываю раздел.");
  });
});
