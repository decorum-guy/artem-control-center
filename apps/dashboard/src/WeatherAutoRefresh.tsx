import { useEffect } from "react";
import { useWeather } from "./Weather";

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export function WeatherAutoRefresh() {
  const { refresh } = useWeather();

  useEffect(() => {
    let lastAttempt = Date.now();
    const refreshIfDue = () => {
      const now = Date.now();
      if (document.visibilityState !== "visible" || now - lastAttempt < REFRESH_INTERVAL_MS) return;
      lastAttempt = now;
      void refresh();
    };
    const timer = window.setInterval(refreshIfDue, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshIfDue);
    window.addEventListener("pageshow", refreshIfDue);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfDue);
      window.removeEventListener("pageshow", refreshIfDue);
    };
  }, [refresh]);

  return null;
}
