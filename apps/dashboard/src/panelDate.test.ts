import { describe, expect, it } from "vitest";
import { formatFreshnessLabel, formatPanelDate } from "./panelDate";

describe("owner-facing diagnostic time", () => {
  it("keeps provider copy and converts timestamp offsets to the panel's local time", () => {
    const iso = "2026-11-17T18:42:00.123+03:00";
    expect(formatFreshnessLabel("Обновлено " + iso)).toBe("Обновлено " + formatPanelDate(iso));
    expect(formatFreshnessLabel("только что")).toBe("только что");
    expect(formatPanelDate("unknown")).toBe("—");
  });
});
