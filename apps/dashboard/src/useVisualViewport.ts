import { useEffect, useState } from "react";

export interface VisualViewportState {
  visibleHeight: number;
  visibleWidth: number;
  offsetTop: number;
  offsetLeft: number;
  bottomInset: number;
}

function readVisualViewport(): VisualViewportState {
  if (typeof window === "undefined") {
    return {
      visibleHeight: 0,
      visibleWidth: 0,
      offsetTop: 0,
      offsetLeft: 0,
      bottomInset: 0
    };
  }

  const viewport = window.visualViewport;
  const visibleHeight = viewport?.height ?? window.innerHeight;
  const visibleWidth = viewport?.width ?? window.innerWidth;
  const offsetTop = viewport?.offsetTop ?? 0;
  const offsetLeft = viewport?.offsetLeft ?? 0;
  const bottomInset = Math.max(0, window.innerHeight - (offsetTop + visibleHeight));
  return { visibleHeight, visibleWidth, offsetTop, offsetLeft, bottomInset };
}

function publishVisualViewport(state: VisualViewportState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--cc-visible-height", `${state.visibleHeight}px`);
  root.style.setProperty("--cc-visible-width", `${state.visibleWidth}px`);
  root.style.setProperty("--cc-viewport-offset-top", `${state.offsetTop}px`);
  root.style.setProperty("--cc-viewport-offset-left", `${state.offsetLeft}px`);
  root.style.setProperty("--cc-viewport-bottom-inset", `${state.bottomInset}px`);
}

export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(readVisualViewport);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const next = readVisualViewport();
      publishVisualViewport(next);
      setState(next);
    };

    update();
    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true });
    viewport?.addEventListener("resize", update, { passive: true });
    viewport?.addEventListener("scroll", update, { passive: true });

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, []);

  return state;
}
