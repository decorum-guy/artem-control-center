import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKUP_PROFILE_ID, BackupApiError, fetchBackups, startBackup } from "./backupsApi";

afterEach(() => vi.unstubAllGlobals());

describe("verified backup API client", () => {
  it("reads sanitized history and sends only the fixed profile id", async () => {
    const response = {
      schemaVersion: "backups.api.v1",
      profiles: [{
        id: BACKUP_PROFILE_ID,
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
      }],
      currentRun: null,
      history: {
        schemaVersion: "backup.history.v1",
        available: true,
        entries: [],
        errorCode: null
      }
    } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: "backups.api.v1", run: { profileId: BACKUP_PROFILE_ID } }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBackups()).resolves.toMatchObject({ schemaVersion: "backups.api.v1" });
    await startBackup();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/backups", { cache: "no-store" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/v1/backups/${BACKUP_PROFILE_ID}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" }
    });
  });

  it("keeps server error codes bounded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "backup_busy" }), { status: 409 })
    ));

    await expect(startBackup()).rejects.toEqual(expect.objectContaining({
      constructor: BackupApiError,
      code: "backup_busy"
    }));
  });
});
