export const BACKUP_PROFILE_ID = "artem-control-center-config" as const;

export type BackupRunState = "preparing" | "exporting" | "verifying" | "success" | "failed";

export interface BackupProfile {
  id: typeof BACKUP_PROFILE_ID;
  name: string;
  project: string;
  environment: string;
  service: string;
  sourceHandlerId: string;
  destinationId: string;
  archiveFormat: string;
  sourceItemCount: number;
  destinationConfigured: boolean;
  available: boolean;
}

export interface BackupRun {
  schemaVersion: "backup.run.v1";
  backupId: string;
  profileId: typeof BACKUP_PROFILE_ID;
  project: string;
  environment: string;
  service: string;
  state: BackupRunState;
  startedAt: string;
  completedAt: string | null;
  artifactFilename: string | null;
  byteSize: number | null;
  verificationStatus: "pending" | "verified" | "failed";
  destinationId: string;
  includedSourceIds: string[];
  missingOptionalSourceIds: string[];
  result: "success" | "failed" | null;
  errorCode: string | null;
}

export interface BackupHistoryEntry {
  backupId: string;
  profileId: typeof BACKUP_PROFILE_ID;
  project: string;
  environment: string;
  service: string;
  startedAt: string;
  completedAt: string | null;
  artifactFilename: string | null;
  byteSize: number | null;
  sha256: string | null;
  archiveFormat: string;
  includedSourceIds: string[];
  missingOptionalSourceIds: string[];
  verificationStatus: "verified" | "failed";
  destinationId: string;
  result: "success" | "failed";
  errorCode?: string;
}

export interface BackupsResponse {
  schemaVersion: "backups.api.v1";
  profiles: BackupProfile[];
  currentRun: BackupRun | null;
  history: {
    schemaVersion: "backup.history.v1";
    available: boolean;
    entries: BackupHistoryEntry[];
    errorCode: string | null;
  };
}

export class BackupApiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "BackupApiError";
    this.code = code;
  }
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `request_failed_${response.status}`;
    try {
      const payload = await response.json() as { detail?: string };
      if (typeof payload.detail === "string") detail = payload.detail;
    } catch {
      // Keep the bounded status-based error.
    }
    throw new BackupApiError(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchBackups(): Promise<BackupsResponse> {
  return parse<BackupsResponse>(await fetch("/api/v1/backups", { cache: "no-store" }));
}

export async function startBackup(): Promise<{ schemaVersion: "backups.api.v1"; run: BackupRun }> {
  return parse<{ schemaVersion: "backups.api.v1"; run: BackupRun }>(await fetch(
    `/api/v1/backups/${BACKUP_PROFILE_ID}/runs`,
    { method: "POST", headers: { "content-type": "application/json" } }
  ));
}
