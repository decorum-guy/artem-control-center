// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let locked = false;
let mutationAllowed = true;

vi.mock("../../InteractionLock", () => ({
  useInteractionLock: () => ({
    locked,
    guardMutation: () => mutationAllowed
  })
}));

import { SystemControlsSettings } from "./SystemControlsSettings";

function payload(volume = 37, brightness = 62) {
  return {
    schemaVersion: 1,
    platform: "windows",
    controls: {
      volume: {
        available: true,
        value: volume,
        reason: null,
        writable: true,
        writeAvailability: "allowed"
      },
      brightness: {
        available: true,
        value: brightness,
        reason: null,
        writable: true,
        writeAvailability: "allowed"
      }
    }
  };
}

describe("SystemControlsSettings", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    locked = false;
    mutationAllowed = true;
    vi.unstubAllGlobals();
  });

  async function mount(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<SystemControlsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("previews drag locally and writes only when the pointer is released", async () => {
    let volume = 37;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/settings/system-controls" && !init?.method) {
        return new Response(JSON.stringify(payload(volume)), { status: 200 });
      }
      if (String(input) === "/api/v1/settings/system-controls/volume" && init?.method === "PATCH") {
        volume = (JSON.parse(String(init.body)) as { value: number }).value;
        return new Response(JSON.stringify(payload(volume)), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: "unexpected" }), { status: 500 });
    });
    await mount(fetchMock);

    const slider = host?.querySelector<HTMLInputElement>("[data-testid=settings-system-volume]");
    if (!slider) throw new Error("volume slider missing");
    expect(slider.value).toBe("37");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, "55");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(slider.value).toBe("55");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      slider.dispatchEvent(new Event("pointerup", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const patchCalls = fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === "/api/v1/settings/system-controls/volume"
      && (init as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patchCalls).toHaveLength(1);
    expect((JSON.parse(String((patchCalls[0][1] as RequestInit).body)) as { value: number }).value).toBe(55);
    expect(slider.value).toBe("55");
    expect(host?.textContent).toContain("Громкость: 55%");
  });

  it("Interaction Lock disables both sliders and prevents writes", async () => {
    locked = true;
    mutationAllowed = false;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(payload()), { status: 200 })
    );
    await mount(fetchMock);

    const volume = host?.querySelector<HTMLInputElement>("[data-testid=settings-system-volume]");
    const brightness = host?.querySelector<HTMLInputElement>("[data-testid=settings-system-brightness]");
    expect(volume?.disabled).toBe(true);
    expect(brightness?.disabled).toBe(true);
    expect(host?.textContent).toContain("Панель заблокирована");

    await act(async () => {
      volume?.dispatchEvent(new Event("pointerup", { bubbles: true }));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders unsupported brightness as unavailable instead of a fake value", async () => {
    const response = payload();
    response.controls.brightness = {
      available: false,
      value: null,
      reason: "unsupported",
      writable: false,
      writeAvailability: "integration_unavailable"
    };
    await mount(vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })));

    const brightness = host?.querySelector<HTMLInputElement>("[data-testid=settings-system-brightness]");
    expect(brightness?.disabled).toBe(true);
    expect(host?.textContent).toContain("Не поддерживается этим устройством");
  });
});
