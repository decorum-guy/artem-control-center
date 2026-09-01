import { useState } from "react";
import type { DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import { ErrorBoundary } from "../../ErrorBoundary";
import { RouteHeader, StatusText, WorkZone } from "../../ShellPrimitives";
import { CollapsibleGroup } from "../operations/CollapsibleGroup";
import { HealthRow } from "../operations/HealthRow";
import {
  countHealth,
  enabledServices,
  healthTone,
  groupHealthyServices,
  isHomeDevice,
  serviceGroupLabels,
  serviceGroupOrder,
  servicesByAttention
} from "../operations/routeDensity";
import { ServiceDetailsSheet } from "./ServiceDetailsSheet";
import { useInterfaceCopy } from "../../interfaceCopy";

export function ServicesV2Page({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { copy } = useInterfaceCopy();
  const [detailsService, setDetailsService] = useState<ServiceSnapshot | null>(null);
  const catalog = enabledServices(snapshot.services).filter((service) => !isHomeDevice(service));
  const counts = countHealth(catalog);
  const attention = servicesByAttention(catalog).filter((service) => service.health !== "healthy");
  const healthyGroups = groupHealthyServices(catalog);
  const attentionSummary = attention.length
    ? `Требуют внимания · ${attention.length}`
    : "Всё в норме";
  const countSummary = `${counts.healthy} в норме · ${counts.degraded + counts.stale} деградировали или устарели · ${counts.offline} недоступны`;

  return (
    <div className="services-v2-page" data-testid="route-services-v2">
      <RouteHeader
        variant="compact"
        title={copy("page.services.title")}
        description={copy("page.services.subtitle")}
        data-testid="services-v2-toolbar"
      />

      <section className={`services-attention-summary${attention.length ? " services-attention-summary--attention" : ""}`} data-testid="services-attention-summary">
        <StatusText label={attentionSummary} tone={attention.length ? healthTone(attention[0].health) : "success"} />
        <span>{countSummary}</span>
      </section>

      <WorkZone className="services-attention-zone" data-testid="services-attention-zone" aria-label="Сервисы, требующие внимания">
        <header className="density-zone-heading">
          <div>
            <p className="section-kicker">Операционная зона</p>
            <h2>{attention.length ? "Сначала проверьте эти сервисы" : "Сервисные состояния"}</h2>
          </div>
          <span>{attention.length ? `${attention.length} требуют внимания` : "Нет открытых состояний"}</span>
        </header>
        <div className="health-row-list">
          {attention.length ? attention.map((service) => (
            <ErrorBoundary key={service.id} title={service.title}>
              <HealthRow service={service} onDetails={() => setDetailsService(service)} />
            </ErrorBoundary>
          )) : (
            <div className="services-attention-empty" data-testid="services-all-healthy">
              <StatusText label="Все подключённые сервисы в норме" tone="success" />
              <span>Подробности здоровых групп остаются свернутыми ниже.</span>
            </div>
          )}
        </div>
      </WorkZone>

      <section className="services-healthy-groups" data-testid="services-healthy-groups">
        {serviceGroupOrder.map((group) => {
          const services = healthyGroups.get(group);
          if (!services?.length) return null;
          return (
            <CollapsibleGroup
              key={group}
              label={serviceGroupLabels[group]}
              count={services.length}
              testId={`healthy-group-${group.toLowerCase().replaceAll(" ", "-")}`}
            >
              <div className="health-row-list health-row-list--healthy">
                {services.map((service) => (
                  <ErrorBoundary key={service.id} title={service.title}>
                    <HealthRow service={service} onDetails={() => setDetailsService(service)} />
                  </ErrorBoundary>
                ))}
              </div>
            </CollapsibleGroup>
          );
        })}
      </section>

      {detailsService && (
        <ServiceDetailsSheet service={detailsService} onClose={() => setDetailsService(null)} />
      )}
    </div>
  );
}
