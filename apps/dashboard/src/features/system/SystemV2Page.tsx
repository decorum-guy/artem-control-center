import { useState } from "react";
import type { DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import { ConnectivityRecoverySurface } from "../../ConnectivityActions";
import { ErrorBoundary } from "../../ErrorBoundary";
import { Icon } from "../../icons";
import { RuntimeControls } from "../../RuntimeControls";
import { Sheet } from "../../Sheet";
import { StatusText, WorkZone } from "../../ShellPrimitives";
import { RogG703DetailControl } from "../../RogG703Controls";
import {
  classifySystemService,
  countHealth,
  healthLabel,
  healthTone,
  systemRelevantServices
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

export function SystemV2Page({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const relevant = systemRelevantServices(snapshot.services);
  const attention = relevant.filter((service) => service.health !== "healthy");
  const counts = countHealth(relevant);
  const rog = relevant.find((service) => classifySystemService(service) === "rog") ?? null;
  const update = relevant.find((service) => classifySystemService(service) === "update") ?? null;
  const backup = relevant.find((service) => classifySystemService(service) === "backup") ?? null;
  const aggregateLabel = !relevant.length
    ? "Состояние недоступно"
    : attention.length
      ? `Требуют внимания · ${attention.length}`
      : "В норме";
  const aggregateTone = !relevant.length
    ? "unavailable"
    : attention.length
      ? healthTone(attention[0].health)
      : "success";

  return (
    <div className="system-v2-page" data-testid="route-system" data-route-variant="v2">
      <header className="density-route-toolbar" data-testid="system-v2-toolbar">
        <h1>Система</h1>
        <button type="button" onClick={() => setDetailsOpen(true)}>О системе</button>
      </header>

      <section className={`system-aggregate-strip${attention.length ? " system-aggregate-strip--attention" : ""}`} data-testid="system-aggregate-strip">
        <div>
          <p className="section-kicker">Диагностика и хосты</p>
          <StatusText label={aggregateLabel} tone={aggregateTone} />
        </div>
        <span>
          {relevant.length
            ? `${counts.healthy} в норме · ${counts.degraded + counts.stale} требуют внимания · ${counts.offline} недоступны`
            : "Нет подтверждённых системных сервисов"}
        </span>
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

        <ErrorBoundary title="Panel Agent">
          <WorkZone className="system-primary-zone system-primary-zone--runtime">
            <RuntimeControls variant="system-v2" />
          </WorkZone>
        </ErrorBoundary>
      </section>

      <section className="system-v2-lower-rows" data-testid="system-lower-rows" aria-label="Системные источники">
        <ConnectivityRecoverySurface services={snapshot.services} showWhenHealthy />
        <SystemFactRow kind="update" label="Обновления и runtime" service={update} />
        <SystemFactRow kind="backup" label="Резервные копии" service={backup} />
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
            <div><dt>Обновления</dt><dd>{update ? healthLabel(update.health) : "источник не подключён"}</dd></div>
            <div><dt>Backup</dt><dd>{backup ? healthLabel(backup.health) : "источник не подключён"}</dd></div>
          </dl>
        </Sheet>
      )}
    </div>
  );
}
