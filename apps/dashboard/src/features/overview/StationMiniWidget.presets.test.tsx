// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StationMiniWidget } from "./StationMiniWidget";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Station preset sheets", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.unstubAllGlobals();
  });

  it("opens the custom list and adds and deletes through revisioned management", async () => {
    let revision = "r1";
    let presets = [{ id: "a1b2c3d4e5f6", title: "Избранное" }];
    const calls: Array<{ path: string; body?: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) as Record<string, string> : undefined;
      calls.push({ path, body });
      if (path.endsWith("/availability")) {
        return new Response(JSON.stringify({ schemaVersion: 1, actions: {
          "media.alice.play": { allowed: true }
        } }), { status: 200 });
      }
      if (options?.method === "POST" && path.endsWith("/presets")) {
        expect(body?.expectedRevision).toBe(revision);
        presets = [...presets, { id: "001122334455", title: body?.title ?? "" }];
        revision = "r2";
      }
      if (options?.method === "DELETE") {
        expect(body).toEqual({ expectedRevision: revision });
        presets = presets.filter((item) => !path.endsWith(item.id));
        revision = "r3";
      }
      return new Response(JSON.stringify({ schemaVersion: 1, revision, updatedAt: "now", presets }), { status: 200 });
    }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root?.render(<StationMiniWidget interactive />); await Promise.resolve(); });
    async function click(text: string) {
      const button = [...(host?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.includes(text));
      if (!button) throw new Error(`Missing ${text}`);
      await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    }
    await click("🎵 Музыка");
    expect(host.querySelectorAll(".station-presets__row")).toHaveLength(1);
    expect(host.querySelector("select")).toBeNull();
    await click("Настроить подборки");
    await click("Добавить");
    const inputs = host.querySelectorAll<HTMLInputElement>(".station-presets__form input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(inputs[0], "Новая");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(inputs[1], "Включи новую");
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Сохранить");
    expect(host.textContent).toContain("Новая");
    await click("Удалить");
    expect(host.textContent).toContain("Удалить «Избранное»?");
    const confirm = host.querySelector<HTMLButtonElement>(".station-presets__confirm button");
    if (!confirm) throw new Error("Confirmation missing");
    await act(async () => { confirm.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(calls.some((call) => call.path.endsWith("/presets") && call.body?.command === "Включи новую")).toBe(true);
    expect(calls.some((call) => call.path.endsWith("/a1b2c3d4e5f6") && call.body?.expectedRevision === "r2")).toBe(true);
  });
});
