import { useEffect } from "react";
import { useWeather } from "./Weather";

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export function WeatherAutoRefresh() {
  const { refresh } = useWeather();

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return null;
}
