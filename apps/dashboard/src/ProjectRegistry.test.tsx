// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRegistryProjectInput, ProjectRegistrySettings } from "@artem/contracts";
import { ProjectRegistryProvider, useProjectRegistry, type ProjectRegistryController } from "./ProjectRegistry";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectInput: ProjectRegistryProjectInput = {
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
};

function registry(revision: number, projects: ProjectRegistrySettings["projects"] = []): ProjectRegistrySettings {
  return {
    schemaVersion: "project.registry.v1",
    revision,
    available: true,
    errorCode: null,
    projects,
    writesEnabled: true,
    manageCapability: "settings.projects.manage",
    manageMinimumProfile: "full"
  };
}

function response(value: ProjectRegistrySettings, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function Harness({ onState }: { onState: (state: ProjectRegistryController) => void }) {
  const state = useProjectRegistry();
  useEffect(() => onState(state), [onState, state]);
  return null;
}

describe("ProjectRegistryProvider controller", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.unstubAllGlobals();
  });

  async function mount(fetchMock: ReturnType<typeof vi.fn>) {
    let latest: ProjectRegistryController | null = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<ProjectRegistryProvider><Harness onState={(state) => { latest = state; }} /></ProjectRegistryProvider>);
      await settle();
    });
    return {
      latest: () => {
        if (!latest) throw new Error("Controller did not render");
        return latest;
      },
      fetchMock
    };
  }

  it("takes the complete server response as authority and shares one in-flight mutation", async () => {
    let resolveMutation!: (value: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return Promise.resolve(response(registry(4)));
      expect(input).toBe("/api/v1/settings/projects");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toMatchObject({ expectedRevision: 4, project: projectInput });
      return new Promise<Response>((resolve) => { resolveMutation = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = await mount(fetchMock);
    expect(harness.latest().registry?.revision).toBe(4);

    let first!: Promise<ProjectRegistrySettings>;
    await act(async () => {
      first = harness.latest().create(projectInput);
      await settle();
    });
    expect(harness.latest().mutationPending).toBe(true);
    const second = harness.latest().create(projectInput);
    expect(second).toBe(first);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);

    await act(async () => {
      resolveMutation(response(registry(5, [{
        id: "server-authority",
        name: "Server authority",
        enabled: false,
        category: "external",
        environments: []
      }])));
      await first;
      await settle();
    });
    expect(harness.latest().registry?.revision).toBe(5);
    expect(harness.latest().registry?.projects[0]?.id).toBe("server-authority");
    expect(harness.latest().mutationPending).toBe(false);
  });

  it("keeps the last confirmed registry when a refresh cannot be confirmed", async () => {
    let failRefresh = false;
    const fetchMock = vi.fn(() => failRefresh
      ? Promise.reject(new Error("network details must stay private"))
      : Promise.resolve(response(registry(2))));
    vi.stubGlobal("fetch", fetchMock);
    const harness = await mount(fetchMock);
    expect(harness.latest().registry?.revision).toBe(2);

    failRefresh = true;
    await act(async () => {
      await harness.latest().refresh();
      await settle();
    });
    expect(harness.latest().registry?.revision).toBe(2);
    expect(harness.latest().error?.code).toBe("network");
  });
});
