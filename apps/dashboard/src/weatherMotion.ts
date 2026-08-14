import { useEffect, useState } from "react";

export type WeatherMotionPolicy = "full" | "reduced" | "low-performance" | "battery-saving" | "hidden";

export interface WeatherMotionState {
  policy: WeatherMotionPolicy;
  paused: boolean;
  hidden: boolean;
}

function readMotionState(): WeatherMotionState {
  if (typeof document === "undefined") {
    return { policy: "full", paused: false, hidden: false };
  }

  const hidden = document.visibilityState === "hidden";
  const app = document.querySelector<HTMLElement>(".app");
  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const policy: WeatherMotionPolicy = hidden
    ? "hidden"
    : app?.classList.contains("motion-reduced") || prefersReduced
      ? "reduced"
      : app?.classList.contains("motion-low-performance")
        ? "low-performance"
        : app?.classList.contains("motion-battery-saving")
          ? "battery-saving"
          : "full";

  return { policy, paused: policy !== "full", hidden };
}

/** One source-owned listener surface for hidden-page and motion policy state. */
export function useWeatherMotionState(): WeatherMotionState {
  const [state, setState] = useState<WeatherMotionState>(readMotionState);

  useEffect(() => {
    const update = () => setState(readMotionState());
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const observer = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(update);

    document.addEventListener("visibilitychange", update);
    media?.addEventListener?.("change", update);
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    observer?.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    update();

    return () => {
      document.removeEventListener("visibilitychange", update);
      media?.removeEventListener?.("change", update);
      observer?.disconnect();
    };
  }, []);

  return state;
}
