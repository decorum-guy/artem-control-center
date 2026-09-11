import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRegistryProjectInput, ProjectRegistrySettings } from "@artem/contracts";
import {
  createProject,
  deleteProject,
  getProjectRegistry,
  parseProjectConnectionTest,
  parseProjectRegistry,
  ProjectRegistryApiError,
  replaceProject,
  testProjectConnection
} from "./projectRegistryApi";

const project: ProjectRegistrySettings["projects"][number] = {
  id: "external-api",
  name: "External API",
  enabled: true,
  category: "external",
  environments: [{
    id: "production",
    services: [{
      id: "api",
      monitor: {
        adapter: "http",
        urlEnv: "EXTERNAL_API_HEALTH_URL",
        intervalSeconds: 60,
        staleAfterSeconds: 180
      },
      actions: [],
      presentation: { widget: "core.generic-service" }
    }]
  }]
};

const registry: ProjectRegistrySettings = {
  schemaVersion: "project.registry.v1",
  revision: 7,
  available: true,
  errorCode: null,
  projects: [project],
  writesEnabled: true,
  manageCapability: "settings.projects.manage",
  manageMinimumProfile: "full"
};

const projectInput: ProjectRegistryProjectInput = {
  id: "new-project",
  name: "New project",
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
};

afterEach(() => vi.unstubAllGlobals());

describe("project registry API", () => {
  it("strictly parses the browser-safe response and rejects unknown keys", () => {
    expect(parseProjectRegistry(registry)).toEqual(registry);
    expect(() => parseProjectRegistry({ ...registry, rawYaml: "projects: []" })).toThrow("invalid_project_registry");
    expect(() => parseProjectRegistry({
      ...registry,
      projects: [{ ...project, environments: [{ ...project.environments[0], services: [{ ...project.environments[0].services[0], monitor: { ...project.environments[0].services[0].monitor, urlEnv: "https://example.com/health" } }] }] }]
    })).toThrow("invalid_url_env");
  });

  it("accepts the closed AVALAR capability bridge without exposing resolved endpoints", () => {
    const avalar = {
      id: "avalar",
      name: "AVALAR",
      enabled: true,
      category: "work" as const,
      environments: [
        {
          id: "main",
          services: [{
            id: "website",
            monitor: { adapter: "avalar" as const, urlEnv: "PANEL_AVALAR_MAIN_URL", intervalSeconds: 60, staleAfterSeconds: 180 },
            details: { adapter: "avalar-ssh" as const },
            actions: ["avalar.main.smoke", "avalar.main.restart", "avalar.main.deploy"],
            presentation: { widget: "core.generic-service" as const }
          }]
        },
        {
          id: "stage",
          services: [{
            id: "website",
            monitor: { adapter: "avalar" as const, urlEnv: "PANEL_AVALAR_STAGE_URL", intervalSeconds: 60, staleAfterSeconds: 180 },
            details: { adapter: "avalar-ssh" as const },
            actions: ["avalar.stage.smoke", "avalar.stage.restart", "avalar.stage.deploy"],
            presentation: { widget: "core.generic-service" as const }
          }]
        }
      ]
    };
    const parsed = parseProjectRegistry({ ...registry, projects: [avalar] });
    expect(parsed.projects[0]).toEqual(avalar);
    expect(JSON.stringify(parsed)).not.toContain("https://");
    expect(JSON.stringify(parsed)).not.toContain("ssh_host");
  });

  it("rejects an unknown action ID at the browser contract boundary", () => {
    const invalid = {
      ...registry,
      projects: [{
        ...project,
        environments: [{
          ...project.environments[0],
          services: [{
            ...project.environments[0].services[0],
            actions: ["avalar.main.unknown"]
          }]
        }]
      }]
    };
    expect(() => parseProjectRegistry(invalid)).toThrow("invalid_service_actions");
  });

  it("gets inventory with a fixed collection endpoint and no-store semantics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(registry), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProjectRegistry()).resolves.toEqual(registry);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/projects", expect.objectContaining({
      cache: "no-store",
      headers: expect.objectContaining({ accept: "application/json" })
    }));
  });

  it("sends the exact canonical create payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(registry), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await createProject(projectInput, 7);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/projects", expect.objectContaining({ method: "POST" }));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 7, project: projectInput });
  });

  it("uses the encoded project path and keeps update id equal in path and payload", async () => {
    const existing = { ...projectInput, id: "new-project" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(registry), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await replaceProject("new-project", existing, 7);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/projects/new-project", expect.objectContaining({ method: "PUT" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ expectedRevision: 7, project: existing });
  });

  it("sends delete with one expected revision and no project body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...registry, projects: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteProject("external-api", 7);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/projects/external-api", expect.objectContaining({ method: "DELETE" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ expectedRevision: 7 });
  });

  it("encodes a project id as one path segment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...registry, projects: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteProject("project/with space", 7);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/projects/project%2Fwith%20space", expect.anything());
  });

  it("maps server detail safely and preserves a distinct network error", async () => {
    const serverFailure = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "secret-bearing-internal-trace" }), { status: 500 }));
    vi.stubGlobal("fetch", serverFailure);
    await expect(getProjectRegistry()).rejects.toMatchObject({ code: "http_error", status: 500 });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("DNS details must not escape")));
    await expect(getProjectRegistry()).rejects.toEqual(new ProjectRegistryApiError("network", 0));
  });

  it("sends one fixed connection-test request with the exact canonical draft and no revision", async () => {
    const result = {
      schemaVersion: "project.connection-test.v1",
      result: "reachable",
      reachable: true,
      httpStatus: 204,
      latencyMs: 42,
      projectId: "new-project",
      environmentId: "production",
      serviceId: "api"
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(testProjectConnection(projectInput, "production", "api")).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/projects/test-connection", expect.objectContaining({ method: "POST" }));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      project: projectInput,
      environmentId: "production",
      serviceId: "api"
    });
    expect(String(init.body)).not.toContain("expectedRevision");
  });

  it.each([
    { field: "projectId", value: "different-project" },
    { field: "environmentId", value: "staging" },
    { field: "serviceId", value: "worker" }
  ] as const)("rejects a connection-test response with a mismatched $field", async ({ field, value }) => {
    const result = {
      schemaVersion: "project.connection-test.v1",
      result: "reachable",
      reachable: true,
      httpStatus: 204,
      latencyMs: 42,
      projectId: "new-project",
      environmentId: "production",
      serviceId: "api",
      [field]: value
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 })));

    await expect(testProjectConnection(projectInput, "production", "api"))
      .rejects.toEqual(new ProjectRegistryApiError("contract_invalid", 200));
  });

  it("strictly parses bounded result metadata and rejects response extras or mismatches", () => {
    const result = {
      schemaVersion: "project.connection-test.v1",
      result: "reachable",
      reachable: true,
      httpStatus: 200,
      latencyMs: 0,
      projectId: "new-project",
      environmentId: "production",
      serviceId: "api"
    };
    expect(parseProjectConnectionTest(result)).toEqual(result);
    expect(() => parseProjectConnectionTest({ ...result, resolvedUrl: "https://secret.example.test" })).toThrow();
    expect(() => parseProjectConnectionTest({ ...result, reachable: false })).toThrow();
    expect(() => parseProjectConnectionTest({ ...result, latencyMs: "42" })).toThrow();
  });

  it("keeps endpoint failure results separate from Panel Agent transport failures", async () => {
    const endpointFailure = {
      schemaVersion: "project.connection-test.v1",
      result: "http_error",
      reachable: false,
      httpStatus: 503,
      latencyMs: 18,
      projectId: "new-project",
      environmentId: "production",
      serviceId: "api"
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(endpointFailure), { status: 200 })));
    await expect(testProjectConnection(projectInput, "production", "api")).resolves.toMatchObject({ result: "http_error", httpStatus: 503 });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("transport details must stay private")));
    await expect(testProjectConnection(projectInput, "production", "api")).rejects.toEqual(new ProjectRegistryApiError("network", 0));
  });
});
