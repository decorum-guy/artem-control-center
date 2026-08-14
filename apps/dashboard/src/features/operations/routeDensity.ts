import type {
  HealthState,
  ServiceGroup,
  ServiceSnapshot
} from "@artem/contracts";
import type { StatusTone } from "../../ShellPrimitives";
import { resolveManifest, servicesByPriority } from "../../registry";

export const healthPresentation: Record<HealthState, { label: string; tone: StatusTone }> = {
  healthy: { label: "В норме", tone: "success" },
  degraded: { label: "Требует внимания", tone: "warning" },
  stale: { label: "Данные устарели", tone: "stale" },
  offline: { label: "Недоступен", tone: "offline" }
};

/** The product vocabulary is deliberately bounded to the contract health states. */
export function healthLabel(health: HealthState): string {
  return healthPresentation[health].label;
}

export function healthTone(health: HealthState): StatusTone {
  return healthPresentation[health].tone;
}

const attentionOrder: Record<HealthState, number> = {
  offline: 0,
  degraded: 1,
  stale: 1,
  healthy: 2
};

/**
 * Keeps the registry's priority order, adding only the normative attention
 * buckets. The index tie-breaker makes equal-health ordering explicit and
 * stable even when a different JS sort implementation is used.
 */
export function servicesByAttention(services: readonly ServiceSnapshot[]): ServiceSnapshot[] {
  return servicesByPriority([...services]).map((service, index) => ({ service, index }))
    .sort((left, right) =>
      attentionOrder[left.service.health] - attentionOrder[right.service.health] ||
      left.index - right.index
    )
    .map(({ service }) => service);
}

export function enabledServices(services: readonly ServiceSnapshot[]): ServiceSnapshot[] {
  return servicesByPriority([...services]);
}

export function isHomeDevice(service: ServiceSnapshot): boolean {
  return service.presentation?.category === "home-device";
}

export function homeAuthority(services: readonly ServiceSnapshot[]): ServiceSnapshot | null {
  return enabledServices(services).find(
    (service) => service.presentation?.role === "home-authority"
  ) ?? null;
}

export interface HomePrimarySelection {
  coffee: ServiceSnapshot | null;
  kettle: ServiceSnapshot | null;
  fallback: ServiceSnapshot | null;
  additional: ServiceSnapshot[];
}

/**
 * Selects only source-owned primary placements. The fallback is intentionally
 * one bounded device, so sparse snapshots never render an empty peer slot.
 */
export function selectHomePrimaryDevices(services: readonly ServiceSnapshot[]): HomePrimarySelection {
  const homeDevices = enabledServices(services).filter(isHomeDevice);
  const coffee = homeDevices.find((service) => resolveManifest(service).id === "home.coffee-machine") ?? null;
  const kettle = homeDevices.find((service) => resolveManifest(service).id === "home.kettle") ?? null;
  const selected = new Set([coffee?.id, kettle?.id]);
  const fallback = !coffee && !kettle ? homeDevices[0] ?? null : null;
  if (fallback) selected.add(fallback.id);

  return {
    coffee,
    kettle,
    fallback,
    additional: homeDevices.filter((service) => !selected.has(service.id))
  };
}

export function homeDeviceState(service: ServiceSnapshot): string {
  const data = service.data as Record<string, unknown>;
  const stage = data.stage;
  if (stage === "on") return "Включён";
  if (stage === "off") return "Выключен";
  if (stage === "unavailable") return "Состояние недоступно";
  return service.summary || "Состояние не указано";
}

export const serviceGroupLabels: Record<ServiceGroup, string> = {
  AVALAR: "AVALAR",
  "Home infrastructure": "Домашняя инфраструктура",
  "Personal infrastructure": "Личная инфраструктура",
  System: "Система",
  "External services": "Внешние сервисы"
};

export const serviceGroupOrder: readonly ServiceGroup[] = [
  "AVALAR",
  "Home infrastructure",
  "Personal infrastructure",
  "System",
  "External services"
];

export function trustedServiceGroup(service: ServiceSnapshot): ServiceGroup {
  return service.presentation?.group ?? "System";
}

export function groupHealthyServices(
  services: readonly ServiceSnapshot[]
): Map<ServiceGroup, ServiceSnapshot[]> {
  const groups = new Map<ServiceGroup, ServiceSnapshot[]>();
  for (const service of enabledServices(services).filter((item) => item.health === "healthy")) {
    const group = trustedServiceGroup(service);
    const current = groups.get(group) ?? [];
    current.push(service);
    groups.set(group, current);
  }
  return groups;
}

export type SystemServiceKind = "rog" | "runtime" | "update" | "backup" | "system" | "other";

/**
 * System placement is restricted to explicit system contracts/categories. A
 * generic or unknown service stays out of the two primary System zones.
 */
export function classifySystemService(service: ServiceSnapshot): SystemServiceKind {
  if (service.id === "rog_g703gi" || service.dataContract === "system.rog-g703.v1") return "rog";
  if (service.dataContract.startsWith("system.runtime.") || service.id.includes("runtime")) return "runtime";
  if (service.dataContract.startsWith("system.update.") || service.dataContract.startsWith("update.")) return "update";
  if (service.dataContract.startsWith("backup.") || service.id.includes("backup")) return "backup";
  if (service.presentation?.category === "system") return "system";
  return "other";
}

export function systemRelevantServices(services: readonly ServiceSnapshot[]): ServiceSnapshot[] {
  return enabledServices(services).filter((service) => classifySystemService(service) !== "other");
}

export function countHealth(services: readonly ServiceSnapshot[]): Record<HealthState, number> {
  return services.reduce<Record<HealthState, number>>((counts, service) => {
    counts[service.health] += 1;
    return counts;
  }, { healthy: 0, degraded: 0, stale: 0, offline: 0 });
}
