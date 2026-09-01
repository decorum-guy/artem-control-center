import { useEffect, useMemo, useState } from "react";
import type { DashboardSnapshot, DiagnosticsProblem, DiagnosticsReport, ServiceSnapshot } from "@artem/contracts";
import { ConnectivityRecoverySurface } from "../../ConnectivityActions";
import { ErrorBoundary } from "../../ErrorBoundary";
import { Icon } from "../../icons";
import { RuntimeControls } from "../../RuntimeControls";
import { Sheet } from "../../Sheet";
import { OperationalStatusSummary, RouteHeader, StatusText, WorkZone } from "../../ShellPrimitives";
import { RogG703DetailControl } from "../../RogG703Controls";
import { useInterfaceCopy } from "../../interfaceCopy";
import {
  copyDiagnosticsText,
  currentProblemsForSnapshot,
  diagnosticsFallbackCopyText,
  diagnosticsSupportText,
  problemStateLabel,
  problemTone
} from "../../problemModel";
import {
  countHealth,
  healthLabel,
  healthTone,
  selectSystemServiceSubjects,
  visibleSystemServices
} from "../operations/routeDensity";

function SystemFactRow({
  kind,
  label,
  service
}: {
  kind: "update" | "backup";
  label: string;
  service: ServiceSnapshot | null;
}) {
  const available = Boolean(service);
  return (
    <div className={`system-fact-row${available ? ` system-fact-row--${service!.health}` : " system-fact-row--unavailable"}`} data-testid={`system-fact-${kind}`}>
      <span className="system-fact-row__icon" aria-hidden="true"><Icon name="system" /></span>
      <div>
        <h3>{label}</h3>
        <p>{service?.presentation?.freshnessLabel ?? service?.summary ?? "Источник не подключён"}</p>
      </div>
      <StatusText
        label={service ? healthLabel(service.health) : "Источник не подключён"}
        tone={service ? healthTone(service.health) : "unavailable"}
      />
    </div>
  );
}

function SystemRuntimeSnapshot({ service }: { service: ServiceSnapshot }) {
  const summary = service.health === "healthy"
    ? "Панель работает нормально"
    : service.health === "degraded"
      ? "Панель требует внимания"
      : "Панель недоступна";
  return (
    <section
      className={`system-runtime-snapshot system-runtime-snapshot--${service.health}`}
      data-testid="system-runtime-snapshot"
      data-service-id={service.id}
      aria-label="Текущее состояние панели"
    >
      <div className="system-runtime-snapshot__copy">
        <p className="section-kicker">Текущее состояние</p>
        <h3>Панель</h3>
        <p>{summary}</p>
        <span>{service.presentation?.freshnessLabel ?? "Свежесть не указана"}</span>
      </div>
      <StatusText label={healthLabel(service.health)} tone={healthTone(service.health)} />
    </section>
  );
}

function SystemDiagnosticRow({ service }: { service: ServiceSnapshot }) {
  return (
    <div
      className={`system-diagnostic-row system-diagnostic-row--${service.health}`}
      data-testid={`system-diagnostic-${service.id}`}
      data-service-id={service.id}
      data-health={service.health}
    >
      <span className="system-diagnostic-row__icon" aria-hidden="true"><Icon name="system" /></span>
      <div className="system-diagnostic-row__copy">
        <h3>{service.title}</h3>
        <p>{service.summary}</p>
      </div>
      <div className="system-diagnostic-row__status">
        <StatusText label={healthLabel(service.health)} tone={healthTone(service.health)} />
        <span>{service.presentation?.freshnessLabel ?? "Свежесть не указана"}</span>
      </div>
    </div>
  );
}

function ProblemRow({ problem }: { problem: DiagnosticsProblem }) {
  return (
    <article
      className={`system-problem-row system-problem-row--${problem.state}`}
      data-testid={`system-problem-${problem.id.replace(/[^a-z0-9]+/gi, "-")}`}
    >
      <div className="system-problem-row__copy">
        <strong>{problem.subsystem}</strong>
        <span>{problem.summary}</span>
      </div>
      <div className="system-problem-row__meta">
        <StatusText label={problemStateLabel(problem.state)} tone={problemTone(problem.state)} />
        <span>{problem.freshness ?? `Наблюдалось ${problem.lastObservedAt}`}</span>
      </div>
    </article>
  );
}

export function SystemV2Page({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { copy } = useInterfaceCopy();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "fallback" | "failed">("idle");
  const [fallbackText, setFallbackText] = useState("");
  const currentProblems = useMemo(() => currentProblemsForSnapshot(snapshot), [snapshot]);
  const subjects = selectSystemServiceSubjects(snapshot.services);
  const { rog, runtime, update, backup, diagnostics } = subjects;
  const relevant = visibleSystemServices(subjects);
  const attention = currentProblems;
  const counts = countHealth(relevant);
  const aggregateLabel = !relevant.length
    ? "Состояние недоступно"
    : attention.length
      ? `Требуют внимания · ${attention.length}`
      : "В норме";
  const aggregateTone = !relevant.length
    ? "unavailable"
    : attention.length
      ? problemTone(attention[0].state)
      : "success";

  useEffect(() => {
    let active = true;
    setReportError(null);
    void fetch("/api/v1/diagnostics?scenario=ha-healthy", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`diagnostics_${response.status}`);
        return await response.json() as DiagnosticsReport;
      })
      .then((next) => {
        if (active) setReport(next);
      })
      .catch(() => {
        if (active) setReportError("Диагностика пока недоступна");
      });
    return () => { active = false; };
  }, [snapshot.revision]);

  async function ensureReport(): Promise<DiagnosticsReport | null> {
    if (report) return report;
    try {
      const response = await fetch("/api/v1/diagnostics?scenario=ha-healthy", { cache: "no-store" });
      if (!response.ok) throw new Error("diagnostics_unavailable");
      const next = await response.json() as DiagnosticsReport;
      setReport(next);
      return next;
    } catch {
      setReportError("Диагностика пока недоступна");
      return null;
    }
  }

  async function copyReport(): Promise<void> {
    const next = await ensureReport();
    if (!next) {
      setCopyState("failed");
      return;
    }
    const text = diagnosticsSupportText(next);
    const copied = await copyDiagnosticsText(text, navigator.clipboard);
    setCopyState(copied ? "copied" : "fallback");
    setFallbackText(text);
  }

  return (
    <div className="system-v2-page" data-testid="route-system" data-route-variant="v2">
      <RouteHeader
        variant="compact"
        title={copy("page.system.title")}
        description={copy("page.system.subtitle")}
        actions={<button type="button" onClick={() => setDetailsOpen(true)}>О системе</button>}
        data-testid="system-v2-toolbar"
      />

      <OperationalStatusSummary
        eyebrow="Диагностика и хосты"
        statusLabel={aggregateLabel}
        tone={aggregateTone}
        detail={relevant.length
          ? `${attention.length} текущих проблем · ${counts.healthy} системных сервисов в норме`
          : attention.length
            ? `${attention.length} текущих проблем`
            : "Нет подтверждённых системных сервисов"}
        attention={attention.length > 0}
        data-testid="system-aggregate-strip"
      />

      <section
        className={`system-problem-surface${attention.length ? " system-problem-surface--attention" : ""}`}
        data-testid="system-problem-details"
        aria-label="Текущие проблемы"
      >
        <header className="system-problem-surface__header">
          <div>
            <p className="section-kicker">Проблемы и диагностика</p>
            <h2>{attention.length ? `Требуют внимания · ${attention.length}` : "Все системы в норме"}</h2>
          </div>
          <button type="button" onClick={() => void copyReport()} data-testid="copy-diagnostics">
            Скопировать диагностику
          </button>
        </header>
        {attention.length ? (
          <div className="system-problem-list">
            {attention.map((item) => <ProblemRow key={item.id} problem={item} />)}
          </div>
        ) : (
          <p className="system-problem-empty">Текущих проблем не обнаружено.</p>
        )}
        {report?.recentTransitions.some((item) => !item.current) && (
          <div className="system-problem-history" data-testid="system-problem-history">
            <p className="section-kicker">Недавние восстановления</p>
            {report.recentTransitions.filter((item) => !item.current).slice(-4).reverse().map((item, index) => (
              <div className="system-problem-history__row" key={`${item.problemId}-${item.observedAt}-${index}`}>
                <span>{item.subsystem}</span>
                <StatusText label="Восстановлено" tone="success" />
                <time dateTime={item.observedAt}>{item.observedAt}</time>
              </div>
            ))}
          </div>
        )}
        {copyState === "copied" && <p className="system-problem-feedback" role="status">Диагностика скопирована.</p>}
        {copyState === "fallback" && (
          <div className="system-problem-fallback" data-testid="diagnostics-fallback">
            <p role="status">{diagnosticsFallbackCopyText}</p>
            <textarea aria-label="Текст диагностики" readOnly value={fallbackText} onFocus={(event) => event.currentTarget.select()} />
          </div>
        )}
        {copyState === "failed" && <p className="system-problem-feedback" role="status">Не удалось подготовить диагностику.</p>}
        {reportError && <p className="system-problem-feedback">{reportError}</p>}
      </section>

      <section className="system-v2-zone-grid" data-testid="system-primary-zones" aria-label="Основные системные зоны">
        {rog ? (
          <ErrorBoundary title={rog.title}>
            <WorkZone className="system-primary-zone system-primary-zone--rog">
              <RogG703DetailControl service={rog} />
            </WorkZone>
          </ErrorBoundary>
        ) : (
          <WorkZone className="system-primary-zone system-primary-zone--missing" data-testid="system-rog-unavailable">
            <Icon name="system" />
            <strong>ASUS ROG G703GI</strong>
            <StatusText label="Недоступен" tone="unavailable" />
            <span>Интеграция не передала подтверждённое состояние.</span>
          </WorkZone>
        )}

        <ErrorBoundary title="Системные действия">
          <WorkZone className="system-primary-zone system-primary-zone--runtime">
            <div className="system-runtime-workzone">
              {runtime && <SystemRuntimeSnapshot service={runtime} />}
              <RuntimeControls variant="system-v2" />
            </div>
          </WorkZone>
        </ErrorBoundary>
      </section>

      <section className="system-v2-lower-rows" data-testid="system-lower-rows" aria-label="Системные источники">
        <ConnectivityRecoverySurface services={snapshot.services} showWhenHealthy />
        <SystemFactRow kind="update" label="Обновления" service={update} />
        <SystemFactRow kind="backup" label="Резервные копии" service={backup} />
        {diagnostics.map((service) => <SystemDiagnosticRow key={service.id} service={service} />)}
      </section>

      {detailsOpen && (
        <Sheet
          title="Система"
          eyebrow="Диагностика"
          description="Показываются только существующие snapshot и runtime-контракты. Панель не создаёт host-метрики или update-состояния."
          onClose={() => setDetailsOpen(false)}
          testId="system-details-sheet"
        >
          <dl className="system-details-sheet__facts">
            <div><dt>Системные сервисы</dt><dd>{relevant.length || "не получены"}</dd></div>
            <div><dt>Здоровые</dt><dd>{counts.healthy}</dd></div>
            <div><dt>Требуют внимания</dt><dd>{attention.length}</dd></div>
            <div><dt>ROG</dt><dd>{rog ? healthLabel(rog.health) : "интеграция недоступна"}</dd></div>
            <div><dt>Диагностика</dt><dd>{diagnostics.length || "нет"}</dd></div>
            <div><dt>Обновления</dt><dd>{update ? healthLabel(update.health) : "источник не подключён"}</dd></div>
            <div><dt>Backup</dt><dd>{backup ? healthLabel(backup.health) : "источник не подключён"}</dd></div>
            <div><dt>Проблемы</dt><dd>{attention.length}</dd></div>
          </dl>
        </Sheet>
      )}
    </div>
  );
}
