import { expect, test, type Page } from "@playwright/test";
import { unlockTouchLockIfNeeded } from "./touch-lock-test-helpers";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const interactionLockEnabled = process.env.VITE_TOUCH_INPUT_LOCK_ENABLED === "true";

type RegistryProject = {
  id: string;
  name: string;
  enabled: boolean;
  category: "external";
  environments: Array<{
    id: string;
    services: Array<{
      id: string;
      monitor: {
        adapter: "http";
        urlEnv: string;
        intervalSeconds: number;
        staleAfterSeconds: number;
      };
      actions: [];
      presentation: { widget: "core.generic-service" };
    }>;
  }>;
};

type Registry = {
  schemaVersion: "project.registry.v1";
  revision: number;
  available: boolean;
  errorCode: null | "config_unavailable" | "malformed_yaml";
  projects: RegistryProject[];
  writesEnabled: boolean;
  manageCapability: "settings.projects.manage";
  manageMinimumProfile: "full";
};

type ProjectInput = {
  id: string;
  name: string;
  enabled?: boolean;
  category: "external";
  environments: Array<{
    id: string;
    services: Array<{
      id: string;
      capabilities: {
        monitor: {
          adapter: "http";
          url_env: string;
          interval_seconds?: number;
          stale_after_seconds?: number;
        };
        actions?: [];
      };
      presentation?: { widget?: "core.generic-service" };
    }>;
  }>;
};

type MutationRecord = { method: string; url: string; body: Record<string, unknown> };
type FailureMode = "conflict" | "reconcile503" | "notFound" | "validation";
type ConnectionMode = "reachable" | "endpoint_not_configured" | "endpoint_invalid" | "http_error" | "unreachable" | "panel_500" | "panel_network";

function project(id = "external-api", enabled = true, name = "External API"): RegistryProject {
  return {
    id,
    name,
    enabled,
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
}

function registry(projects: RegistryProject[] = [], overrides: Partial<Registry> = {}): Registry {
  return {
    schemaVersion: "project.registry.v1",
    revision: 0,
    available: true,
    errorCode: null,
    projects,
    writesEnabled: true,
    manageCapability: "settings.projects.manage",
    manageMinimumProfile: "full",
    ...overrides
  };
}

function projectFromInput(input: ProjectInput): RegistryProject {
  return {
    id: input.id,
    name: input.name,
    enabled: input.enabled ?? true,
    category: "external",
    environments: input.environments.map((environment) => ({
      id: environment.id,
      services: environment.services.map((service) => ({
        id: service.id,
        monitor: {
          adapter: "http",
          urlEnv: service.capabilities.monitor.url_env,
          intervalSeconds: service.capabilities.monitor.interval_seconds ?? 60,
          staleAfterSeconds: service.capabilities.monitor.stale_after_seconds ?? 180
        },
        actions: [],
        presentation: { widget: "core.generic-service" }
      }))
    }))
  };
}

function accessStatus(mode: "full" | "elevation") {
  const isFull = mode === "full";
  return {
    schemaVersion: 1,
    revision: isFull ? 2 : 1,
    baseProfile: isFull ? "full" : "standard",
    effectiveProfile: isFull ? "full" : "standard",
    temporaryFull: false,
    temporaryFullExpiresAt: null,
    confirmationPolicy: {
      actionConfirmationRequired: !isFull,
      mode: isFull ? "manual_persistent_full" : "profile_default"
    },
    pinConfigured: true,
    lockoutUntil: null,
    capabilities: {
      "settings.projects.manage": {
        capability: "settings.projects.manage",
        minimumProfile: "full",
        effectiveProfile: isFull ? "full" : "standard",
        allowed: isFull,
        availability: isFull ? "allowed" : "elevation_required"
      }
    }
  };
}

async function installFixtures(
  page: Page,
  options: {
    initial?: Registry;
    access?: "full" | "elevation";
    failure?: FailureMode;
    connection?: ConnectionMode;
    deferInitialGet?: boolean;
    deferMutation?: boolean;
    deferConnectionTest?: boolean;
  } = {}
) {
  let current = options.initial ?? registry();
  let accessMode = options.access ?? "full";
  let failure = options.failure;
  const connection = options.connection ?? "reachable";
  let initialGetRelease: (() => void) | null = null;
  let mutationRelease: (() => void) | null = null;
  let connectionRelease: (() => void) | null = null;
  const initialGetGate = new Promise<void>((resolve) => { initialGetRelease = resolve; });
  const mutationGate = new Promise<void>((resolve) => { mutationRelease = resolve; });
  const connectionGate = new Promise<void>((resolve) => { connectionRelease = resolve; });
  const mutations: MutationRecord[] = [];
  const connectionTests: MutationRecord[] = [];
  let getCount = 0;

  await page.route("**/api/v1/access", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accessStatus(accessMode)) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/access/unlock", async (route) => {
    if (route.request().method() === "POST") {
      accessMode = "full";
      current = { ...current, writesEnabled: true };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ...accessStatus("full"),
        revision: 3,
        baseProfile: "standard",
        temporaryFull: true,
        temporaryFullExpiresAt: "2099-01-01T00:30:00Z",
        confirmationPolicy: { actionConfirmationRequired: true, mode: "temporary_full" }
      }) });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/v1/settings/projects", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      mutations.push({ method: request.method(), url: new URL(request.url()).pathname, body });
      if (options.deferMutation) await mutationGate;

      if (failure === "validation") {
        failure = undefined;
        await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "invalid_project_payload" }) });
        return;
      }
      if (failure === "conflict") {
        failure = undefined;
        current = { ...current, revision: current.revision + 1, projects: [...current.projects, project("server-project", true, "Server project")] };
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "revision_conflict" }) });
        return;
      }
      if (failure === "reconcile503") {
        failure = undefined;
        const input = body.project as ProjectInput;
        current = { ...current, revision: current.revision + 1, projects: [...current.projects, projectFromInput(input)] };
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "project_registry_runtime_reconciliation_failed" }) });
        return;
      }

      const input = body.project as ProjectInput;
      const saved = projectFromInput(input);
      current = { ...current, revision: current.revision + 1, projects: [...current.projects, saved] };
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(current) });
      return;
    }
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    getCount += 1;
    // The dashboard runs under React StrictMode in development, so the
    // provider may issue the initial read twice before the first response.
    if (options.deferInitialGet && getCount <= 2) await initialGetGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) });
  });

  await page.route("**/api/v1/settings/projects/*", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    mutations.push({ method: request.method(), url: new URL(request.url()).pathname, body });
    if (options.deferMutation) await mutationGate;

    if (failure === "validation") {
      failure = undefined;
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "invalid_project_payload" }) });
      return;
    }
    if (failure === "conflict") {
      failure = undefined;
      current = { ...current, revision: current.revision + 1, projects: [...current.projects, project("server-project", true, "Server project")] };
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "revision_conflict" }) });
      return;
    }
    if (failure === "reconcile503") {
      failure = undefined;
      const input = body.project as ProjectInput;
      current = { ...current, revision: current.revision + 1, projects: [...current.projects, projectFromInput(input)] };
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "project_registry_runtime_reconciliation_failed" }) });
      return;
    }
    if (failure === "notFound") {
      failure = undefined;
      const projectId = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1) ?? "");
      current = { ...current, revision: current.revision + 1, projects: current.projects.filter((entry) => entry.id !== projectId) };
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "project_not_found" }) });
      return;
    }

    if (request.method() === "DELETE") {
      const projectId = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1) ?? "");
      current = { ...current, revision: current.revision + 1, projects: current.projects.filter((entry) => entry.id !== projectId) };
    } else {
      const input = body.project as ProjectInput;
      const saved = projectFromInput(input);
      const exists = current.projects.some((entry) => entry.id === saved.id);
      current = {
        ...current,
        revision: current.revision + 1,
        projects: exists
          ? current.projects.map((entry) => entry.id === saved.id ? saved : entry)
          : [...current.projects, saved]
      };
    }
    await route.fulfill({ status: request.method() === "POST" ? 201 : 200, contentType: "application/json", body: JSON.stringify(current) });
  });

  await page.route("**/api/v1/settings/projects/test-connection", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    connectionTests.push({ method: request.method(), url: new URL(request.url()).pathname, body });
    if (options.deferConnectionTest) await connectionGate;

    if (connection === "panel_network") {
      await route.abort("failed");
      return;
    }
    if (connection === "panel_500") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "internal probe trace" }) });
      return;
    }

    const projectInput = body.project as ProjectInput;
    const result = connection === "reachable"
      ? { result: "reachable", reachable: true, httpStatus: 204, latencyMs: 42 }
      : connection === "endpoint_not_configured"
        ? { result: "endpoint_not_configured", reachable: false, httpStatus: null, latencyMs: null }
        : connection === "endpoint_invalid"
          ? { result: "endpoint_invalid", reachable: false, httpStatus: null, latencyMs: null }
          : connection === "http_error"
            ? { result: "http_error", reachable: false, httpStatus: 503, latencyMs: 18 }
            : { result: "unreachable", reachable: false, httpStatus: null, latencyMs: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      schemaVersion: "project.connection-test.v1",
      ...result,
      projectId: projectInput.id,
      environmentId: body.environmentId,
      serviceId: body.serviceId
    }) });
  });

  return {
    current: () => current,
    mutations,
    connectionTests,
    getCount: () => getCount,
    releaseInitialGet: () => initialGetRelease?.(),
    releaseMutation: () => mutationRelease?.(),
    releaseConnectionTest: () => connectionRelease?.(),
    setAccessMode: (next: "full" | "elevation") => { accessMode = next; }
  };
}

async function openProjectSheet(page: Page, fixture: Awaited<ReturnType<typeof installFixtures>>) {
  await page.goto("/settings");
  await expect(page.getByTestId("route-settings")).toBeVisible();
  await expect(page.getByTestId("settings-summary-projects")).toBeVisible();
  await page.getByTestId("settings-summary-projects").click();
  await expect(page.getByTestId("settings-projects-sheet")).toBeVisible();
  return fixture;
}

async function fillNewProject(page: Page, suffix = "") {
  const sheet = page.getByTestId("settings-projects-sheet");
  await sheet.getByRole("button", { name: "Добавить проект", exact: true }).click();
  await sheet.getByLabel("Название", { exact: true }).fill(`Мой API${suffix}`);
  await sheet.getByLabel("ID проекта", { exact: true }).fill(`my-api${suffix ? "-two" : ""}`);
  await sheet.getByLabel("Переменная с адресом", { exact: true }).fill("EXTERNAL_API_HEALTH_URL");
  return sheet;
}

test.describe("Slice C/D monitor-only project onboarding in Settings", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the project Settings gate.");

  test("summary, loading and empty registry states are owner-facing", async ({ page }) => {
    const fixture = await installFixtures(page, { deferInitialGet: true });
    await page.goto("/settings");
    const summary = page.getByTestId("settings-summary-projects");
    await expect(summary).toContainText("Загрузка");
    fixture.releaseInitialGet();
    await expect(summary).toContainText("Нет добавленных проектов");
    await expect(summary).toContainText("Доступно");
    await summary.click();
    await expect(page.getByTestId("settings-projects-sheet")).toContainText("Нет добавленных проектов.");
  });

  test("lists existing monitor-only projects and keeps the Sheet bounded", async ({ page }) => {
    await openProjectSheet(page, await installFixtures(page, { initial: registry([project()]) }));
    const card = page.getByTestId("project-card-external-api");
    await expect(card).toContainText("External API");
    await expect(card).toContainText("ID: external-api");
    await expect(card).toContainText("Только мониторинг");
    await expect(card).toContainText("production · api");
    await expect(card).toContainText("EXTERNAL_API_HEALTH_URL");
    await expect(page.getByTestId("settings-summary-projects")).toContainText("1 проект");
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(page.getByTestId("settings-projects-sheet")).toHaveCount(0);
  });

  test("available=false is explicit and removes all mutation affordances", async ({ page }) => {
    await openProjectSheet(page, await installFixtures(page, {
      initial: registry([], { available: false, errorCode: "malformed_yaml", writesEnabled: false })
    }));
    await expect(page.getByTestId("settings-summary-projects")).toContainText("Недоступно");
    await expect(page.getByTestId("settings-projects-sheet")).toContainText("Настройки проектов временно недоступны.");
    await expect(page.getByRole("button", { name: "Добавить проект", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeVisible();
  });

  test("Add editor has safe endpoint reference, exact defaults and canonical create success", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page));
    const sheet = await fillNewProject(page);
    await expect(sheet.getByLabel("Окружение", { exact: true })).toHaveValue("production");
    await expect(sheet.getByLabel("Сервис", { exact: true })).toHaveValue("api");
    await expect(sheet.getByLabel("Интервал проверки, секунд", { exact: true })).toHaveValue("60");
    await expect(sheet.getByLabel("Когда считать данные устаревшими, секунд", { exact: true })).toHaveValue("180");
    await expect(sheet.locator("input[type=url], input[name=url], input[name=endpoint], input[name=token], input[name=password], input[name=secret], input[name=apiKey], textarea")).toHaveCount(0);
    await expect(sheet.getByTestId("project-url-env")).toHaveAttribute("type", "text");
    await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByTestId("project-card-my-api")).toContainText("Мой API");
    await expect(page.getByRole("status")).toContainText("Проект добавлен.");
    expect(fixture.mutations).toHaveLength(1);
    expect(fixture.mutations[0]).toMatchObject({ method: "POST", url: "/api/v1/settings/projects" });
    expect(fixture.mutations[0]?.body).toEqual({
      expectedRevision: 0,
      project: {
        id: "my-api",
        name: "Мой API",
        enabled: true,
        category: "external",
        environments: [{
          id: "production",
          services: [{
            id: "api",
            capabilities: {
              monitor: { adapter: "http", url_env: "EXTERNAL_API_HEALTH_URL", interval_seconds: 60, stale_after_seconds: 180 },
              actions: []
            },
            presentation: { widget: "core.generic-service" }
          }]
        }]
      }
    });
  });

  test("connection test is a separate current-draft operation with an explicit safe preview", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page));
    const sheet = await fillNewProject(page);
    const testButton = sheet.getByTestId("project-test-connection");

    await expect(testButton).toBeVisible();
    const buttonSize = await testButton.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(buttonSize.width).toBeGreaterThanOrEqual(48);
    expect(buttonSize.height).toBeGreaterThanOrEqual(48);
    await expect(sheet).toContainText("Проверка не сохраняет изменения.");
    await expect(sheet).not.toContainText(/\bdraft\b/i);

    await testButton.click();
    await expect(sheet.getByTestId("project-preview")).toContainText("Предпросмотр");
    await expect(sheet.getByTestId("project-preview")).toContainText("Только мониторинг");
    await expect(sheet.getByTestId("project-preview")).toContainText("Соединение доступно");
    await expect(sheet.getByTestId("project-preview")).toContainText("HTTP 204 · 42 мс");
    await expect(sheet.getByTestId("project-preview").getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("project-card-my-api")).toHaveCount(0);

    expect(fixture.connectionTests).toHaveLength(1);
    expect(fixture.mutations).toHaveLength(0);
    expect(fixture.current()).toMatchObject({ revision: 0, projects: [] });
    expect(fixture.connectionTests[0]?.body).toMatchObject({
      project: {
        id: "my-api",
        name: "Мой API",
        environments: [{ id: "production", services: [{ id: "api" }] }]
      },
      environmentId: "production",
      serviceId: "api"
    });
    expect(fixture.connectionTests[0]?.body).not.toHaveProperty("expectedRevision");

    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.goto("/services");
    await expect(page.getByTestId("route-services-v2")).toBeVisible();
    await expect(page.getByText("Мой API", { exact: true })).toHaveCount(0);
  });

  test("connection test is single-flight and blocks save until its response", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { deferConnectionTest: true }));
    const sheet = await fillNewProject(page);
    const testButton = sheet.getByTestId("project-test-connection");
    await testButton.click();
    await expect.poll(() => fixture.connectionTests.length).toBe(1);
    await expect(testButton).toBeDisabled();
    await expect(testButton).toHaveAttribute("aria-busy", "true");
    await expect(testButton).toHaveText("Проверяем…");

    await page.evaluate(() => document.getElementById("project-editor-form")?.requestSubmit());
    await expect.poll(() => fixture.mutations.length).toBe(0);
    await expect.poll(() => fixture.connectionTests.length).toBe(1);
    fixture.releaseConnectionTest();
    await expect(sheet.getByTestId("project-preview")).toContainText("Соединение доступно");
    await expect(testButton).toBeEnabled();
  });

  test("editing tests the current draft URL-env name without changing the saved registry", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { initial: registry([project()]) }));
    const sheet = page.getByTestId("settings-projects-sheet");
    await page.getByTestId("project-edit-external-api").click();
    await sheet.getByLabel("Переменная с адресом", { exact: true }).fill("NEW_API_HEALTH_URL");
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet.getByTestId("project-preview")).toContainText("Соединение доступно");
    expect(fixture.connectionTests).toHaveLength(1);
    expect(fixture.connectionTests[0]?.body).toMatchObject({
      project: { environments: [{ services: [{ capabilities: { monitor: { url_env: "NEW_API_HEALTH_URL" } } }] }] }
    });
    expect(fixture.mutations).toHaveLength(0);
    expect(fixture.current()).toMatchObject({ revision: 0, projects: [{ environments: [{ services: [{ monitor: { urlEnv: "EXTERNAL_API_HEALTH_URL" } }] }] }] });
  });

  test("missing endpoint value remains informative without disabling Save", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { connection: "endpoint_not_configured" }));
    const sheet = await fillNewProject(page);
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet.getByTestId("project-preview")).toContainText("Переменная EXTERNAL_API_HEALTH_URL не настроена на компьютере панели.");
    await expect(sheet.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
    expect(fixture.connectionTests).toHaveLength(1);
    expect(fixture.mutations).toHaveLength(0);
  });

  test("invalid endpoint value remains informative without disabling Save", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { connection: "endpoint_invalid" }));
    const sheet = await fillNewProject(page);
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet.getByTestId("project-preview")).toContainText("В переменной указан некорректный адрес.");
    await expect(sheet.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
    expect(fixture.connectionTests).toHaveLength(1);
    expect(fixture.mutations).toHaveLength(0);
  });

  test("invalid draft sends no connection-test request", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page));
    const sheet = await fillNewProject(page);
    await sheet.getByLabel("Название", { exact: true }).fill("");
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet.getByText("Введите название проекта.", { exact: true })).toBeVisible();
    await expect(sheet).toContainText("Проверьте поля проекта.");
    expect(fixture.connectionTests).toHaveLength(0);
    expect(fixture.mutations).toHaveLength(0);
  });

  test("HTTP failure uses explicit owner-facing result copy and leaves Save available", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { connection: "http_error" }));
    const sheet = await fillNewProject(page);
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet.getByTestId("project-preview")).toContainText("Сервис ответил с ошибкой HTTP 503.");
    await expect(sheet.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
    expect(fixture.connectionTests).toHaveLength(1);
    expect(fixture.mutations).toHaveLength(0);
  });

  test("endpoint failure uses distinct owner-facing result copy and leaves Save available", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { connection: "unreachable" }));
    const sheet = await fillNewProject(page);
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet.getByTestId("project-preview")).toContainText("Не удалось подключиться к сервису.");
    await expect(sheet.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
    expect(fixture.connectionTests).toHaveLength(1);
    expect(fixture.mutations).toHaveLength(0);
  });

  test("Panel Agent failure is not presented as an external endpoint failure", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { connection: "panel_network" }));
    const sheet = await fillNewProject(page);
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet).toContainText("Панель не смогла выполнить проверку.");
    await expect(sheet).not.toContainText("Не удалось подключиться к сервису.");
    await expect(sheet.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
    expect(fixture.connectionTests).toHaveLength(1);
    expect(fixture.mutations).toHaveLength(0);
  });

  test("Panel Agent API failure remains separate from endpoint status", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { connection: "panel_500" }));
    const sheet = await fillNewProject(page);
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet).toContainText("Не удалось проверить соединение.");
    await expect(sheet).not.toContainText("Не удалось подключиться к сервису.");
    await expect(sheet.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
    expect(fixture.connectionTests).toHaveLength(1);
    expect(fixture.mutations).toHaveLength(0);
  });

  test("changing any draft field clears an earlier connection result without creating a write", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page));
    const sheet = await fillNewProject(page);
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet.getByTestId("project-preview")).toContainText("Соединение доступно");
    await sheet.getByLabel("Название", { exact: true }).fill("Изменённый API");
    await expect(sheet.getByTestId("project-preview")).toContainText("Ещё не проверено");
    await expect(sheet.getByTestId("project-preview")).not.toContainText("Соединение доступно");
    await expect(sheet.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
    expect(fixture.connectionTests).toHaveLength(1);
    expect(fixture.mutations).toHaveLength(0);
  });

  test("create is single-flight and the editor stays pending until the server response", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { deferMutation: true }));
    const sheet = await fillNewProject(page);
    const save = sheet.getByRole("button", { name: /Сохран/ });
    await save.click();
    await expect.poll(() => fixture.mutations.length).toBe(1);
    await expect(save).toBeDisabled();
    await page.evaluate(() => document.getElementById("project-editor-form")?.requestSubmit());
    await expect.poll(() => fixture.mutations.length).toBe(1);
    fixture.releaseMutation();
    await expect(page.getByTestId("project-card-my-api")).toBeVisible();
  });

  test("edit keeps the stable id, and disable/re-enable each send one full replace", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { initial: registry([project()]) }));
    const sheet = page.getByTestId("settings-projects-sheet");
    await page.getByTestId("project-edit-external-api").click();
    await expect(sheet.getByLabel("ID проекта", { exact: true })).toBeDisabled();
    await sheet.getByLabel("Название", { exact: true }).fill("Updated API");
    await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByTestId("project-card-external-api")).toContainText("Updated API");
    expect(fixture.mutations[0]).toMatchObject({ method: "PUT", url: "/api/v1/settings/projects/external-api" });
    expect(fixture.mutations[0]?.body).toMatchObject({ expectedRevision: 0, project: { id: "external-api", name: "Updated API" } });

    const disable = page.getByRole("checkbox", { name: "Выключить проект «Updated API»" });
    await disable.click();
    await expect(page.getByTestId("project-card-external-api")).toContainText("Выключен");
    expect(fixture.mutations).toHaveLength(2);
    expect(fixture.mutations[1]?.body).toMatchObject({ expectedRevision: 1, project: { id: "external-api", enabled: false } });

    const enable = page.getByRole("checkbox", { name: "Включить проект «Updated API»" });
    await enable.click();
    await expect(page.getByTestId("project-card-external-api")).toContainText("Включён");
    expect(fixture.mutations).toHaveLength(3);
    expect(fixture.mutations[2]?.body).toMatchObject({ expectedRevision: 2, project: { id: "external-api", enabled: true } });
  });

  test("writesEnabled=false keeps inventory readable and blocks project writes", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, {
      initial: registry([project()], { writesEnabled: false })
    }));
    const sheet = page.getByTestId("settings-projects-sheet");
    await expect(page.getByTestId("settings-summary-projects")).toContainText("Только чтение");
    await expect(sheet.getByTestId("project-card-external-api")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Добавить проект", exact: true })).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Изменить", exact: true })).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Удалить", exact: true })).toBeDisabled();
    await expect(sheet.getByRole("checkbox")).toBeDisabled();
    expect(fixture.mutations).toHaveLength(0);
  });

  test("delete always uses the shared custom confirmation, cancel is zero and confirm is one DELETE", async ({ page }) => {
    await page.addInitScript(() => {
      window.confirm = () => { throw new Error("native confirm must not be used"); };
    });
    const fixture = await openProjectSheet(page, await installFixtures(page, { initial: registry([project()]) }));
    const sheet = page.getByTestId("settings-projects-sheet");
    await sheet.getByRole("button", { name: "Удалить", exact: true }).click();
    const confirmation = page.getByTestId("action-confirmation");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText("Удалить проект «External API»?");
    await expect(confirmation).toContainText("Мониторинг проекта будет удалён из Control Center.");
    await confirmation.getByRole("button", { name: "Отмена", exact: true }).click();
    expect(fixture.mutations).toHaveLength(0);

    await sheet.getByRole("button", { name: "Удалить", exact: true }).click();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Удалить проект", exact: true }).click();
    await expect(page.getByTestId("project-card-external-api")).toHaveCount(0);
    expect(fixture.mutations).toHaveLength(1);
    expect(fixture.mutations[0]).toMatchObject({ method: "DELETE", url: "/api/v1/settings/projects/external-api", body: { expectedRevision: 0 } });
  });

  test("409 revision conflict refetches authority, closes the draft and shows no success", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { failure: "conflict" }));
    const sheet = await fillNewProject(page);
    await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByTestId("project-settings")).toContainText("Список проектов изменился. Показано последнее подтверждённое состояние.");
    await expect(page.getByTestId("project-editor-form")).toHaveCount(0);
    await expect(page.getByTestId("project-card-server-project")).toBeVisible();
    await expect(page.getByTestId("project-settings")).not.toContainText("Проект добавлен.");
    expect(fixture.getCount()).toBe(3);
  });

  test("503 reconciliation failure refetches authority without claiming config was not saved", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { failure: "reconcile503" }));
    const sheet = await fillNewProject(page);
    await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByTestId("project-settings")).toContainText("Не удалось применить изменение к работающей панели. Состояние проектов обновлено.");
    await expect(page.getByTestId("project-card-my-api")).toBeVisible();
    await expect(page.getByTestId("project-settings")).not.toContainText("не сохран");
    expect(fixture.getCount()).toBe(3);
  });

  test("404 deletion refetches the latest inventory", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { initial: registry([project()]), failure: "notFound" }));
    const sheet = page.getByTestId("settings-projects-sheet");
    await sheet.getByRole("button", { name: "Удалить", exact: true }).click();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Удалить проект", exact: true }).click();
    await expect(page.getByTestId("project-settings")).toContainText("Проект уже был изменён. Список проектов обновлён.");
    expect(fixture.getCount()).toBe(3);
    expect(fixture.mutations).toHaveLength(1);
    await expect(page.getByTestId("project-card-external-api")).toHaveCount(0);
  });

  test("422 validation failure keeps the draft and makes no optimistic inventory change", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { failure: "validation" }));
    const sheet = await fillNewProject(page);
    await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(sheet.getByTestId("project-editor-form")).toBeVisible();
    await expect(sheet).toContainText("Проверьте данные проекта. Подтверждённый список проектов не изменён.");
    expect(fixture.mutations).toHaveLength(1);
    expect(fixture.getCount()).toBe(2);
    await expect(page.getByTestId("project-card-my-api")).toHaveCount(0);
  });

  test("Full-only capability reuses the existing PIN elevation flow", async ({ page }) => {
    const fixture = await openProjectSheet(page, await installFixtures(page, { access: "elevation", initial: registry([], { writesEnabled: false }) }));
    await expect(page.getByRole("button", { name: "Разрешить изменения", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Разрешить изменения", exact: true }).click();
    const pinModal = page.locator(".pin-modal");
    await expect(pinModal).toBeVisible();
    for (const digit of ["1", "2", "3", "4"]) await pinModal.getByRole("button", { name: digit, exact: true }).click();
    await pinModal.getByRole("button", { name: "Разблокировать", exact: true }).click();
    await expect(page.getByRole("button", { name: "Добавить проект", exact: true })).toBeEnabled();
    const sheet = await fillNewProject(page);
    await sheet.getByTestId("project-test-connection").click();
    await expect(sheet.getByTestId("project-preview")).toContainText("Соединение доступно");
    expect(fixture.connectionTests).toHaveLength(1);
    await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByTestId("project-card-my-api")).toBeVisible();
    expect(fixture.mutations).toHaveLength(1);
  });

  test("interaction lock prevents a project mutation request", async ({ page }) => {
    test.skip(!interactionLockEnabled, "Run with VITE_TOUCH_INPUT_LOCK_ENABLED=true for the lock gate.");
    const fixture = await installFixtures(page, { initial: registry([project()]) });
    await page.goto("/settings");
    await unlockTouchLockIfNeeded(page);
    const control = page.getByTestId("interaction-lock-control");
    await control.focus();
    await page.keyboard.down("Space");
    await page.waitForTimeout(1_100);
    await page.keyboard.up("Space");
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("settings-summary-projects").click({ force: true });
    await page.getByTestId("project-edit-external-api").click({ force: true });
    await page.getByRole("button", { name: "Сохранить", exact: true }).click({ force: true });
    await expect(page.getByTestId("project-settings")).toContainText("Панель заблокирована");
    expect(fixture.mutations).toHaveLength(0);
  });

  test("interaction lock prevents a connection-test request", async ({ page }) => {
    test.skip(!interactionLockEnabled, "Run with VITE_TOUCH_INPUT_LOCK_ENABLED=true for the lock gate.");
    const fixture = await installFixtures(page);
    await page.goto("/settings");
    await unlockTouchLockIfNeeded(page);
    const control = page.getByTestId("interaction-lock-control");
    await control.focus();
    await page.keyboard.down("Space");
    await page.waitForTimeout(1_100);
    await page.keyboard.up("Space");
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("settings-summary-projects").click({ force: true });
    const sheet = page.getByTestId("settings-projects-sheet");
    await sheet.getByRole("button", { name: "Добавить проект", exact: true }).click({ force: true });
    await sheet.getByLabel("Название", { exact: true }).fill("Мой API", { force: true });
    await sheet.getByLabel("ID проекта", { exact: true }).fill("my-api", { force: true });
    await sheet.getByLabel("Переменная с адресом", { exact: true }).fill("EXTERNAL_API_HEALTH_URL", { force: true });
    await sheet.getByTestId("project-test-connection").click({ force: true });
    await expect(sheet).toContainText("Панель заблокирована");
    expect(fixture.connectionTests).toHaveLength(0);
    expect(fixture.mutations).toHaveLength(0);
  });

  test("1280x720 project editor has no document overflow and keeps controls at the touch floor", async ({ page }) => {
    await openProjectSheet(page, await installFixtures(page));
    const sheet = await fillNewProject(page);
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth
    }));
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
    expect(overflow.body, JSON.stringify(overflow)).toBeLessThanOrEqual(1);
    const undersized = await sheet.locator("button, input").evaluateAll((elements) => elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width < 48 || rect.height < 48
        ? [{ tag: element.tagName, name: element.getAttribute("name"), width: rect.width, height: rect.height }]
        : [];
    }));
    expect(undersized, JSON.stringify(undersized)).toEqual([]);
  });
});
