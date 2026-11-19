import { useState } from "react";
import type { DashboardSnapshot } from "@artem/contracts";
import { ErrorBoundary } from "../../ErrorBoundary";
import { OperationalStatusSummary, RouteHeader, SectionHeader, StatusText, WorkZone } from "../../ShellPrimitives";
import { CollapsibleGroup } from "../operations/CollapsibleGroup";
import { HealthRow } from "../operations/HealthRow";
import {
  countHealth,
  enabledServices,
  healthTone,
  groupServicesWithoutIncidents,
  isHomeDevice,
  serviceGroupLabels,
  serviceGroupOrder,
  servicesByAttention
} from "../operations/routeDensity";
import { ServiceDetailsSheet } from "./ServiceDetailsSheet";
import { useInterfaceCopy } from "../../interfaceCopy";
import { serviceNeedsAttention } from "../../problemModel";

export function ServicesV2Page({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { copy } = useInterfaceCopy();
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const detailsService = snapshot.services.find(service => service.id === detailsId);
  const catalog = enabledServices(snapshot.services).filter((service) => !isHomeDevice(service));
  const counts = countHealth(catalog);
  const attention = servicesByAttention(catalog).filter(serviceNeedsAttention);
  const healthyGroups = groupServicesWithoutIncidents(catalog);
  const quietOffline = catalog.some(service => service.health !== "healthy" && !serviceNeedsAttention(service));
  const attentionSummary = attention.length
    ? `Требуют внимания · ${attention.length}`
    : quietOffline ? "Нет активных проблем" : "Всё в норме";
  const countSummary = `${counts.healthy} в норме · ${counts.degraded + counts.stale} деградировали или устарели · ${counts.offline} недоступны`;

  return (
    <div className="services-v2-page" data-testid="route-services-v2">
      <RouteHeader
        variant="compact"
        title={copy("page.services.title")}
        description={copy("page.services.subtitle")}
        data-testid="services-v2-toolbar"
      />

      <OperationalStatusSummary
        statusLabel={attentionSummary}
        tone={attention.length ? healthTone(attention[0].health === "healthy" ? "degraded" : attention[0].health) : "success"}
        detail={countSummary}
        attention={attention.length > 0}
        data-testid="services-attention-summary"
      />

      <WorkZone className="services-attention-zone" data-testid="services-attention-zone" aria-label="Сервисы, требующие внимания">
        <SectionHeader
          eyebrow="Операционная зона"
          title={attention.length ? "Сначала проверьте эти сервисы" : "Сервисные состояния"}
          metadata={attention.length ? `${attention.length} требуют внимания` : "Нет открытых состояний"}
        />
        <div className="health-row-list">
          {attention.length ? attention.map((service) => (
            <ErrorBoundary key={service.id} title={service.title}>
              <HealthRow service={service} onDetails={() => setDetailsId(service.id)} />
            </ErrorBoundary>
          )) : (
            <div className="services-attention-empty" data-testid="services-all-healthy">
              <StatusText label={quietOffline ? "Нет активных проблем" : "Все подключённые сервисы в норме"} tone="success" />
              <span>Состояния сервисов доступны в группах ниже.</span>
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
                    <HealthRow service={service} onDetails={() => setDetailsId(service.id)} />
                  </ErrorBoundary>
                ))}
              </div>
            </CollapsibleGroup>
          );
        })}
      </section>

      {detailsService && (
        <ServiceDetailsSheet service={detailsService} onClose={() => setDetailsId(null)} />
      )}
    </div>
  );
}
