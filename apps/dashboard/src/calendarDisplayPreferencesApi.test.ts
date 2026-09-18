import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { getCalendarDisplayPreferences, patchCalendarDisplayPreference, CalendarDisplayPreferencesApiError } from "./calendarDisplayPreferencesApi";

describe("calendarDisplayPreferencesApi", () => {
  let globalFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    globalFetchMock = vi.fn();
    global.fetch = globalFetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const validResponse = {
    schemaVersion: "calendar.display-preferences.v1",
    revision: 1,
    updatedAt: "2024-01-01T00:00:00Z",
    available: true,
    writesEnabled: true,
    warnings: [],
    overrides: [
      { providerId: "provider-1", calendarId: "cal-1", color: "#FF0000" }
    ]
  };

  test("valid GET response", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => validResponse
    });

    const result = await getCalendarDisplayPreferences();
    expect(result).toEqual(validResponse);
    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/settings/calendar/display-colors", expect.objectContaining({
      cache: "no-store",
      headers: expect.objectContaining({ accept: "application/json", "content-type": "application/json" })
    }));
  });

  test("valid override/color normalization behavior", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ...validResponse,
        overrides: [{ providerId: "p", calendarId: "c", color: "#aabbcc" }]
      })
    });

    const result = await getCalendarDisplayPreferences();
    expect(result.overrides[0].color).toBe("#AABBCC");
  });

  test("network error -> expected bounded API error", async () => {
    globalFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(getCalendarDisplayPreferences()).rejects.toThrow(CalendarDisplayPreferencesApiError);

    globalFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    try {
      await getCalendarDisplayPreferences();
    } catch(e) {
      expect(e).toBeInstanceOf(CalendarDisplayPreferencesApiError);
      expect((e as CalendarDisplayPreferencesApiError).status).toBe(0);
      expect((e as CalendarDisplayPreferencesApiError).code).toBe("network");
    }
  });

  test("non-2xx JSON detail", async () => {
    globalFetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: "revision_conflict" })
    });

    await expect(getCalendarDisplayPreferences()).rejects.toThrow(CalendarDisplayPreferencesApiError);

    globalFetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: "revision_conflict" })
    });
    try {
      await getCalendarDisplayPreferences();
    } catch(e) {
      expect(e).toBeInstanceOf(CalendarDisplayPreferencesApiError);
      expect((e as CalendarDisplayPreferencesApiError).status).toBe(409);
      expect((e as CalendarDisplayPreferencesApiError).code).toBe("revision_conflict");
    }
  });

  test("malformed successful response -> contract error", async () => {
    globalFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ not: "a valid response" })
    });

    await expect(getCalendarDisplayPreferences()).rejects.toThrow(CalendarDisplayPreferencesApiError);
  });

  test("invalid color", async () => {
    globalFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...validResponse,
        overrides: [{ providerId: "p", calendarId: "c", color: "red" }] // invalid
      })
    });

    await expect(getCalendarDisplayPreferences()).rejects.toThrow(CalendarDisplayPreferencesApiError);
  });

  test("invalid warning code", async () => {
    globalFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...validResponse,
        warnings: ["invalid_warning_code"]
      })
    });

    await expect(getCalendarDisplayPreferences()).rejects.toThrow(CalendarDisplayPreferencesApiError);
  });

  test("PATCH uses expected route/method/body", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => validResponse
    });

    await patchCalendarDisplayPreference({ expectedRevision: 1, providerId: "p", calendarId: "c", color: "#112233" });

    expect(globalFetchMock).toHaveBeenCalledWith("/api/v1/settings/calendar/display-colors", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: 1, providerId: "p", calendarId: "c", color: "#112233" })
    }));
  });

  test("successful PATCH response is parsed through the same strict contract", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ not: "valid" })
    });

    await expect(patchCalendarDisplayPreference({ expectedRevision: 1, providerId: "p", calendarId: "c", color: null })).rejects.toThrow(CalendarDisplayPreferencesApiError);
  });
});
