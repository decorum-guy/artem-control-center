// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePortraitViewport } from "./viewportLayout";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("uses measured CSS aspect ratio and preserves focused draft through repeated rotation", async () => {
  let portrait = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({ get matches() { return portrait; }, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }));
  function Surface() { const vertical = usePortraitViewport(); const [draft, setDraft] = useState(""); return <div data-portrait={vertical}><input aria-label="Draft" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} /></div>; }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Surface />));
    const input = host.querySelector("input")!; input.focus();
    await act(async () => { input.value = "Несохранённая задача"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    for (const value of [true, false, true, false]) {
      await act(async () => { portrait = value; listeners.forEach((listener) => listener()); });
      expect(host.firstElementChild?.getAttribute("data-portrait")).toBe(String(value));
      expect(document.activeElement).toBe(input); expect(input.value).toBe("Несохранённая задача");
    }
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
  expect(listeners.size).toBe(0);
});
