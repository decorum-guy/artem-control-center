import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRegistryProjectInput, ProjectRegistrySettings } from "@artem/contracts";
import {
  createProject,
  deleteProject,
  getProjectRegistry,
  parseProjectRegistry,
  ProjectRegistryApiError,
  replaceProject
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
});
