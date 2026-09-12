import { useCallback, useEffect, useMemo, useState } from "react";
import { RouteHeader, StatusText, WorkZone } from "./ShellPrimitives";
import { useActionConfirmation } from "./ActionConfirmations";
import { useAccess } from "./AccessControls";
import { useInteractionLock } from "./InteractionLock";
import { useNoticeCenter } from "./NoticeCenter";
import { pageSubtitleField, pageTitleField, useInterfaceCopy } from "./interfaceCopy";
import {
  BACKUP_PROFILE_ID,
  BackupApiError,
  fetchBackups,
  startBackup,
  type BackupHistoryEntry,
  type BackupRun,
  type BackupsResponse
} from "./backupsApi";
import "./Backups.css";

const ACTIVE_STATES = new Set(["preparing", "exporting", "verifying"]);

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Размер неизвестен";
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function failureCopy(code: string | null): string {
  switch (code) {
    case "backup_insufficient_free_space": return "Недостаточно свободного места для резервной копии.";
    case "backup_busy": return "Другая резервная копия уже выполняется.";
    case "backup_source_unavailable": return "Часть конфигурации панели сейчас недоступна.";
    case "backup_history_unavailable": return "История резервных копий недоступна; попробуйте позже.";
    case "backup_destination_unavailable": return "Хранилище резервных копий недоступно.";
    case "backup_verification_failed": return "Резервная копия не прошла проверку целостности.";
    case "backup_manifest_failed": return "Не удалось сохранить описание резервной копии.";
    default: return "Не удалось создать проверенную резервную копию.";
  }
}

function isActive(run: BackupRun | null): boolean {
  return Boolean(run && ACTIVE_STATES.has(run.state));
}

function latestSuccess(data: BackupsResponse | null): BackupHistoryEntry | null {
  return data?.history.entries.find((entry) => entry.result === "success") ?? null;
}

export function BackupsPage() {
  const { copy } = useInterfaceCopy();
  const { status: accessStatus, available: accessAvailable, ensureCapability } = useAccess();
  const { guardMutation } = useInteractionLock();
  const { confirmAction } = useActionConfirmation();
  const { showNotice } = useNoticeCenter();
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchBackups();
      setData(next);
      setRequestError(null);
    } catch {
      setRequestError("Не удалось получить состояние резервных копий.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (isActive(data?.currentRun ?? null)) void load();
    }, 700);
    return () => window.clearInterval(timer);
  }, [data?.currentRun, load]);

  const profile = data?.profiles.find((item) => item.id === BACKUP_PROFILE_ID) ?? null;
  const currentRun = data?.currentRun ?? null;
  const latest = latestSuccess(data);
  const capability = accessStatus?.capabilities["backup.create"];
  const canCreate = Boolean(
    profile?.destinationConfigured &&
    profile.available &&
    !isActive(currentRun) &&
    !starting &&
    accessAvailable &&
    (!accessStatus || capability?.allowed)
  );
  const destinationReady = Boolean(profile?.destinationConfigured && profile.available);

  const currentStatus = useMemo(() => {
    if (!currentRun) return null;
    if (isActive(currentRun)) {
      if (currentRun.state === "preparing") return "Подготавливаем резервную копию…";
      if (currentRun.state === "exporting") return "Сохраняем конфигурацию панели…";
      return "Проверяем архив и manifest…";
    }
    if (currentRun.result === "success") return "Резервная копия проверена";
    if (currentRun.result === "failed") return failureCopy(currentRun.errorCode);
    return null;
  }, [currentRun]);

  async function createBackup() {
    if (!guardMutation() || starting || !canCreate) return;
    if (!(await ensureCapability("backup.create", "Создать резервную копию"))) return;
    const confirmation = await confirmAction("backup.create", {
      title: "Создать резервную копию?",
      target: "Control Center",
      revision: currentRun?.backupId
    });
    if (!confirmation.confirmed || !guardMutation()) return;
    setStarting(true);
    try {
      await startBackup();
      showNotice({
        id: "backup.create",
        correlationId: currentRun?.backupId,
        severity: "progress",
        title: "Резервная копия запускается",
        detail: "Панель сохранит локальный архив и проверит его перед публикацией.",
        timeoutMs: 8_000
      });
      await load();
    } catch (error) {
      const code = error instanceof BackupApiError ? error.code : null;
      showNotice({
        id: "backup.create.error",
        severity: "error",
        title: "Резервная копия не запущена",
        detail: failureCopy(code),
        timeoutMs: 10_000
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="backups-page" data-testid="route-backups">
      <RouteHeader
        eyebrow="Надёжность"
        title={copy(pageTitleField("backups"))}
        description={copy(pageSubtitleField("backups"))}
      />

      {loading && <p className="backups-state" data-testid="backups-loading">Проверяем резервные копии…</p>}
      {requestError && <p className="backups-state backups-state--error" role="alert">{requestError}</p>}

      <WorkZone className="backups-work-zone">
        <section className="backups-card" aria-labelledby="backups-profile-title">
          <div className="backups-card__header">
            <div>
              <p className="section-kicker">Профиль</p>
              <h2 id="backups-profile-title">Control Center</h2>
              <p>Конфигурация панели · локальная копия</p>
            </div>
            <StatusText
              label={currentRun?.result === "success" ? "Проверено" : destinationReady ? "Готово" : "Не настроено"}
              tone={currentRun?.result === "success" ? "success" : destinationReady ? "neutral" : "unavailable"}
            />
          </div>

          {!destinationReady && (
            <p className="backups-state backups-state--warning" data-testid="backups-unconfigured">
              Хранилище резервных копий не настроено.
            </p>
          )}

          <div className="backups-summary" data-testid="backups-summary">
            <div>
              <span>Последний результат</span>
              <strong>
                {latest ? "Проверенная копия" : currentRun?.result === "failed" ? "Не удалось создать" : "Пока нет копии"}
              </strong>
            </div>
            <div>
              <span>Время</span>
              <strong>{formatDate(latest?.completedAt ?? currentRun?.completedAt ?? null)}</strong>
            </div>
            <div>
              <span>Размер</span>
              <strong>{formatBytes(latest?.byteSize ?? currentRun?.byteSize ?? null)}</strong>
            </div>
          </div>

          {currentStatus && (
            <p
              className={`backups-run-status${isActive(currentRun) ? " backups-run-status--active" : currentRun?.result === "failed" ? " backups-run-status--error" : ""}`}
              role={currentRun?.result === "failed" ? "alert" : "status"}
              data-testid="backups-current-status"
            >
              {currentStatus}
            </p>
          )}

          <div className="backups-actions">
            <button
              type="button"
              className="backups-primary-action"
              data-testid="backup-create"
              disabled={!canCreate}
              aria-busy={starting || isActive(currentRun)}
              onClick={() => { void createBackup(); }}
            >
              {starting || isActive(currentRun) ? "Создаём копию…" : "Создать резервную копию"}
            </button>
            <span className="backups-privacy-note">Локальное хранилище панели · архив проверяется перед публикацией</span>
          </div>
        </section>
      </WorkZone>
    </div>
  );
}
