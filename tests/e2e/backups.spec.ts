import { expect, test, type Page } from "@playwright/test";

const profile = {
  id: "artem-control-center-config",
  name: "Control Center",
  project: "artem-control-center",
  environment: "local-panel",
  service: "panel-agent",
  sourceHandlerId: "panel-config",
  destinationId: "laptop-primary",
  archiveFormat: "zip",
  sourceItemCount: 6,
  destinationConfigured: true,
  available: true
};

const access = {
  schemaVersion: 1,
  revision: 1,
  baseProfile: "full",
  effectiveProfile: "full",
  temporaryFull: false,
  temporaryFullExpiresAt: null,
  pinConfigured: true,
  lockoutUntil: null,
  confirmationPolicy: { actionConfirmationRequired: false, mode: "manual_persistent_full" },
  capabilities: {
    "backup.create": {
      capability: "backup.create",
      minimumProfile: "full",
      effectiveProfile: "full",
      allowed: true,
      availability: "allowed"
    }
  }
};

function successRun() {
  return {
    schemaVersion: "backup.run.v1",
    backupId: "backup-e2e-success",
    profileId: profile.id,
    project: profile.project,
    environment: profile.environment,
    service: profile.service,
    state: "success",
    startedAt: "2026-09-12T00:00:00Z",
    completedAt: "2026-09-12T00:00:03Z",
    artifactFilename: "artem-control-center-config-20260912T000000Z-backup-e2e-success.zip",
    byteSize: 2048,
    verificationStatus: "verified",
    destinationId: profile.destinationId,
    includedSourceIds: ["overview.layout"],
    missingOptionalSourceIds: [],
    result: "success",
    errorCode: null
  };
}

async function installAccess(page: Page) {
  await page.route(/\/api\/v1\/access$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(access) });
  });
}

async function installBackupResponse(page: Page, initial: Record<string, unknown>, onStart?: () => Record<string, unknown>) {
  let payload = initial;
  await page.route(/\/api\/v1\/backups$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.route(/\/api\/v1\/backups\/[^/]+\/runs$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    payload = onStart?.() ?? payload;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ schemaVersion: "backups.api.v1", run: payload.currentRun }) });
  });
}

test.describe("verified local backups surface", () => {
  test("shows the unconfigured destination without exposing server paths", async ({ page }) => {
    await installBackupResponse(page, {
      schemaVersion: "backups.api.v1",
      profiles: [{ ...profile, destinationConfigured: false, available: false }],
      currentRun: null,
      history: { schemaVersion: "backup.history.v1", available: false, entries: [], errorCode: "backup_destination_unavailable" }
    });

    await page.goto("/backups");
    await expect(page.getByTestId("route-backups")).toBeVisible();
    await expect(page.getByTestId("backups-unconfigured")).toHaveText("Хранилище резервных копий не настроено.");
    await expect(page.getByTestId("backup-create")).toBeDisabled();
    await expect(page.getByTestId("route-backups")).not.toContainText("PANEL_BACKUP_LOCAL_ROOT");
  });

  test("renders loading, verified success, and failure states", async ({ page }) => {
    let releaseLoading!: () => void;
    const loading = new Promise<void>((resolve) => { releaseLoading = resolve; });
    await page.route(/\/api\/v1\/access$/, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(access) });
    });
    await page.route(/\/api\/v1\/backups$/, async (route) => {
      await loading;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        schemaVersion: "backups.api.v1",
        profiles: [profile],
        currentRun: successRun(),
        history: { schemaVersion: "backup.history.v1", available: true, entries: [successRun()], errorCode: null }
      }) });
    });
    const navigation = page.goto("/backups");
    await expect(page.getByTestId("backups-loading")).toBeVisible();
    releaseLoading();
    await navigation;
    await expect(page.getByTestId("backups-current-status")).toHaveText("Резервная копия проверена");
    await expect(page.getByTestId("backups-summary")).toContainText("Проверенная копия");

    await page.unroute(/\/api\/v1\/backups$/);
    await page.route(/\/api\/v1\/backups$/, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        schemaVersion: "backups.api.v1",
        profiles: [profile],
        currentRun: { ...successRun(), state: "failed", result: "failed", verificationStatus: "failed", errorCode: "backup_verification_failed" },
        history: { schemaVersion: "backup.history.v1", available: true, entries: [], errorCode: null }
      }) });
    });
    await page.reload();
    await expect(page.getByTestId("backups-current-status")).toHaveText("Резервная копия не прошла проверку целостности.");
  });

  test("creates a fixed-profile backup and keeps touch geometry safe", async ({ page }) => {
    const run = successRun();
    const entry = { ...run, sha256: "a".repeat(64) };
    await installAccess(page);
    await installBackupResponse(page, {
      schemaVersion: "backups.api.v1",
      profiles: [profile],
      currentRun: null,
      history: { schemaVersion: "backup.history.v1", available: true, entries: [], errorCode: null }
    }, () => ({
      schemaVersion: "backups.api.v1",
      profiles: [profile],
      currentRun: run,
      history: { schemaVersion: "backup.history.v1", available: true, entries: [entry], errorCode: null }
    }));

    await page.goto("/backups");
    await expect(page.getByTestId("backup-create")).toBeEnabled();
    await page.getByTestId("backup-create").click();
    await expect(page.getByTestId("backups-current-status")).toHaveText("Резервная копия проверена");

    const geometry = await page.getByTestId("backup-create").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth
      };
    });
    expect(geometry.height).toBeGreaterThanOrEqual(48);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);

    await page.setViewportSize({ width: 640, height: 360 });
    await expect(page.getByTestId("backup-create")).toBeVisible();
    const narrow = await page.getByTestId("backup-create").evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth
    }));
    expect(narrow.height).toBeGreaterThanOrEqual(48);
    expect(narrow.documentWidth).toBeLessThanOrEqual(narrow.viewportWidth + 1);
  });
});
