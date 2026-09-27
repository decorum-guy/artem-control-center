import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StationMiniWidget } from "./StationMiniWidget";
import { STATION_ACTIONS } from "../../stationActionsApi";

describe("Station Mini 2 Overview widget", () => {
  it("shows the seven fixed controls and no invented playback values", () => {
    const html = renderToStaticMarkup(<StationMiniWidget interactive />);
    for (const label of ["Play", "Pause", "Volume down", "Volume up", "Previous track", "Next track", "Like current track"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(STATION_ACTIONS).toHaveLength(7);
    expect(html).toContain("station-artwork-slot");
    expect(html).not.toMatch(/volume level|progress|album artwork|now playing|текущий трек|громкость:/i);
  });

  it("keeps touch targets and reduced-motion glow rules", () => {
    const css = readFileSync(new URL("./overviewWidgets.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.station-mini-widget__button\s*\{[^}]*min-width:\s*48px;[^}]*min-height:\s*48px;/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*\.station-mini-widget__glow\s*\{\s*transition:\s*none;/s);
  });
});
