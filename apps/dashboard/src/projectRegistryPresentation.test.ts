import { describe, expect, it } from "vitest";
import type { ProjectRegistrySettings } from "@artem/contracts";
import { projectRegistryStateLabel, projectRegistrySummary } from "./projectRegistryPresentation";

const inventory = (overrides: Partial<ProjectRegistrySettings> = {}): ProjectRegistrySettings => ({
  schemaVersion: "project.registry.v1",
  revision: 1,
  available: true,
  errorCode: null,
  projects: [],
  writesEnabled: true,
  manageCapability: "settings.projects.manage",
  manageMinimumProfile: "full",
  ...overrides
});

describe("project registry Settings summary", () => {
  it("describes loading, empty, enabled counts and read-only states", () => {
    expect(projectRegistrySummary(true, null)).toBe("Загружаем список проектов…");
    expect(projectRegistryStateLabel(true, null)).toBe("Загрузка");
    expect(projectRegistrySummary(false, inventory())).toBe("Нет добавленных проектов");
    const projects = [
      { id: "one", name: "One", enabled: true, category: "external" as const, environments: [] },
      { id: "two", name: "Two", enabled: false, category: "external" as const, environments: [] },
      { id: "three", name: "Three", enabled: true, category: "external" as const, environments: [] }
    ];
    expect(projectRegistrySummary(false, inventory({ projects }))).toBe("3 проекта · 2 включены");
    expect(projectRegistryStateLabel(false, inventory({ writesEnabled: false }))).toBe("Только чтение");
  });

  it("distinguishes unavailable inventory and failed confirmation", () => {
    expect(projectRegistrySummary(false, inventory({ available: false, errorCode: "config_unavailable" }))).toBe("Настройки проектов временно недоступны");
    expect(projectRegistryStateLabel(false, inventory({ available: false, errorCode: "config_unavailable" }))).toBe("Недоступно");
    expect(projectRegistrySummary(false, null, true)).toBe("Не удалось подтвердить состояние проектов");
    expect(projectRegistryStateLabel(false, null, true)).toBe("Недоступно");
  });
});
