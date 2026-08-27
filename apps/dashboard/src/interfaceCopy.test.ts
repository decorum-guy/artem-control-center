import { describe, expect, it } from "vitest";
import { defaultInterfaceCopyCatalog, copyFromCatalog, pageSubtitleField, pageTitleField } from "./interfaceCopy";
import { parseInterfaceCopy } from "./interfaceCopyApi";

function response(overrides: unknown = {
  navigation: {},
  navigationGroup: {},
  page: {
    overview: {}, weather: {}, home: {}, services: {}, calendar: {}, tasks: {},
    reminders: {}, backups: {}, apps: {}, system: {}, settings: {}
  }
}) {
  return {
    schemaVersion: "interface.copy-settings.v1",
    revision: 0,
    recoveryRevision: null,
    updatedAt: "2026-08-27T00:00:00Z",
    defaults: defaultInterfaceCopyCatalog,
    overrides,
    effective: defaultInterfaceCopyCatalog,
    available: true,
    warnings: [],
    writesEnabled: true
  };
}

describe("interface copy contract", () => {
  it("resolves shipped defaults and page field identities", () => {
    expect(copyFromCatalog(defaultInterfaceCopyCatalog, "navigation.overview")).toBe("Обзор");
    expect(copyFromCatalog(defaultInterfaceCopyCatalog, "page.overview.subtitle")).toBe("Сегодня, всё важное в первом экране");
    expect(pageTitleField("calendar")).toBe("page.calendar.title");
    expect(pageSubtitleField("calendar")).toBe("page.calendar.subtitle");
  });

  it("preserves an explicitly removed subtitle while rejecting unknown response keys", () => {
    const parsed = parseInterfaceCopy(response({
      navigation: {},
      navigationGroup: {},
      page: {
        overview: { subtitle: "" }, weather: {}, home: {}, services: {}, calendar: {}, tasks: {},
        reminders: {}, backups: {}, apps: {}, system: {}, settings: {}
      }
    }));
    expect(parsed.overrides.page.overview.subtitle).toBe("");
    expect(() => parseInterfaceCopy({ ...response(), unexpected: "route./overview" })).toThrow();
  });

  it("rejects HTML and controls in server responses", () => {
    expect(() => parseInterfaceCopy(response({
      navigation: { overview: "<script>" },
      navigationGroup: {},
      page: {
        overview: {}, weather: {}, home: {}, services: {}, calendar: {}, tasks: {},
        reminders: {}, backups: {}, apps: {}, system: {}, settings: {}
      }
    }))).toThrow();
  });

  it("accepts the explicit recovery revision for an unavailable store", () => {
    const parsed = parseInterfaceCopy({
      ...response(),
      available: false,
      recoveryRevision: 0,
      warnings: ["stored_copy_settings_unavailable"]
    });
    expect(parsed.recoveryRevision).toBe(0);
    expect(parsed.available).toBe(false);
  });
});
