import { describe, expect, it } from "vitest";
import type { ProjectRegistryProject } from "@artem/contracts";
import {
  DEFAULT_PROJECT_DRAFT,
  normalizeProjectDraft,
  projectDraftFromRegistry,
  projectInputFromDraft,
  projectInputFromRegistry,
  validateProjectDraft
} from "./projectRegistryForm";

const existing: ProjectRegistryProject = {
  id: "external-api",
  name: "External API",
  enabled: false,
  category: "external",
  environments: [{
    id: "production",
    services: [{
      id: "api",
      monitor: { adapter: "http", urlEnv: "EXTERNAL_API_HEALTH_URL", intervalSeconds: 60, staleAfterSeconds: 180 },
      actions: [],
      presentation: { widget: "core.generic-service" }
    }]
  }]
};

describe("monitor-only project editor", () => {
  it("starts with the Slice C defaults", () => {
    expect(DEFAULT_PROJECT_DRAFT).toMatchObject({
      environmentId: "production",
      serviceId: "api",
      intervalSeconds: 60,
      staleAfterSeconds: 180,
      enabled: true
    });
  });

  it("builds the exact canonical nested create/update input", () => {
    const input = projectInputFromDraft({
      id: "my-api",
      name: "Мой API",
      enabled: true,
      environmentId: "production",
      serviceId: "api",
      urlEnv: "EXTERNAL_API_HEALTH_URL",
      intervalSeconds: 60,
      staleAfterSeconds: 180
    });
    expect(input).toEqual({
      id: "my-api",
      name: "Мой API",
      enabled: true,
      category: "external",
      environments: [{
        id: "production",
        services: [{
          id: "api",
          capabilities: {
            monitor: {
              adapter: "http",
              url_env: "EXTERNAL_API_HEALTH_URL",
              interval_seconds: 60,
              stale_after_seconds: 180
            },
            actions: []
          },
          presentation: { widget: "core.generic-service" }
        }]
      }]
    });
  });

  it("hydrates edit mode without allowing a project id migration", () => {
    const draft = projectDraftFromRegistry(existing);
    expect(draft).toMatchObject({ id: "external-api", enabled: false, urlEnv: "EXTERNAL_API_HEALTH_URL" });
    expect(projectInputFromDraft({ ...draft!, id: "external-api" }).id).toBe(existing.id);
    expect(projectInputFromRegistry({ ...existing, enabled: true }).enabled).toBe(true);
  });

  it("preserves multi-environment capabilities when toggling a non-editor project", () => {
    const avalar: ProjectRegistryProject = {
      id: "avalar",
      name: "AVALAR",
      enabled: true,
      category: "work",
      environments: [
        {
          id: "main",
          services: [{
            id: "website",
            monitor: { adapter: "avalar", urlEnv: "PANEL_AVALAR_MAIN_URL", intervalSeconds: 60, staleAfterSeconds: 180 },
            details: { adapter: "avalar-ssh" },
            actions: ["avalar.main.smoke", "avalar.main.deploy"],
            presentation: { widget: "core.generic-service" }
          }]
        },
        {
          id: "stage",
          services: [{
            id: "website",
            monitor: { adapter: "avalar", urlEnv: "PANEL_AVALAR_STAGE_URL", intervalSeconds: 60, staleAfterSeconds: 180 },
            details: { adapter: "avalar-ssh" },
            actions: ["avalar.stage.smoke", "avalar.stage.deploy"],
            presentation: { widget: "core.generic-service" }
          }]
        }
      ]
    };
    expect(projectInputFromRegistry({ ...avalar, enabled: false })).toMatchObject({
      category: "work",
      enabled: false,
      environments: avalar.environments.map((environment) => ({
        id: environment.id,
        services: [{
          id: "website",
          capabilities: {
            monitor: expect.objectContaining({ adapter: "avalar", url_env: environment.id === "main" ? "PANEL_AVALAR_MAIN_URL" : "PANEL_AVALAR_STAGE_URL" }),
            details: { adapter: "avalar-ssh" },
            actions: environment.id === "main" ? ["avalar.main.smoke", "avalar.main.deploy"] : ["avalar.stage.smoke", "avalar.stage.deploy"]
          }
        }]
      }))
    });
  });

  it("uses server-aligned validation bounds and does not accept a URL value", () => {
    const invalid = validateProjectDraft({
      ...DEFAULT_PROJECT_DRAFT,
      id: "External API",
      name: "API",
      urlEnv: "https://example.com/health",
      intervalSeconds: 4,
      staleAfterSeconds: 14
    });
    expect(invalid.id).toBeTruthy();
    expect(invalid.urlEnv).toBeTruthy();
    expect(invalid.intervalSeconds).toBeTruthy();
    expect(invalid.staleAfterSeconds).toBeTruthy();
    expect(validateProjectDraft(normalizeProjectDraft({
      ...DEFAULT_PROJECT_DRAFT,
      id: "my-api",
      name: " API ",
      urlEnv: "EXTERNAL_API_HEALTH_URL"
    }))).toEqual({});
  });
});
