import { useSyncExternalStore } from "react";

/** Measured CSS layout viewport; keyboard visual insets belong to Sheet. */
function portraitSnapshot(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(max-aspect-ratio: 1/1)").matches ?? window.innerHeight >= window.innerWidth);
}
function subscribe(listener: () => void): () => void {
  const query = window.matchMedia?.("(max-aspect-ratio: 1/1)");
  query?.addEventListener("change", listener);
  window.addEventListener("resize", listener, { passive: true });
  return () => { query?.removeEventListener("change", listener); window.removeEventListener("resize", listener); };
}
export function usePortraitViewport(): boolean {
  return useSyncExternalStore(subscribe, portraitSnapshot, () => false);
}
