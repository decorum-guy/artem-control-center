export type PanelMode = "fixtures" | "read_only" | "integration_test" | "production";
export type HealthState = "healthy" | "degraded" | "offline" | "stale";
export type SourceMode = "live" | "cached" | "fixture" | "stale" | "unavailable";
export type CoffeeStage =
  | "off"
  | "turning_on"
  | "warming"
  | "ready"
  | "running"
  | "running_too_long"
  | "turning_off"
  | "unavailable"
  | "stale";
export type CoffeeDeviceState =
  | "off"
  | "on"
  | "turning_on"
  | "turning_off"
  | "unavailable"
  | "stale";
export type KettleStage = "on" | "off" | "unavailable";
export type ServiceCategory =
  | "home-device"
  | "home-infrastructure"
  | "work"
  | "personal-infrastructure"
  | "system"
  | "external";
export type ServiceOverviewPlacement =
  | "primary"
  | "quick-control"
  | "aggregate"
  | "incident-only"
  | "none";
export type ServiceGroup =
  | "AVALAR"
  | "Home infrastructure"
  | "Personal infrastructure"
  | "System"
  | "External services";

export interface ActionDescriptor {
  id: string;
  title: string;
  enabled: boolean;
  risk: "low" | "medium" | "high";
}

export interface CoffeeMachineState {
  entityId: "switch.kofemashina";
  authority: "home-assistant";
  state: CoffeeDeviceState;
  available: boolean;
  turnedOnAt: string | null;
  entityLastChangedAt: string | null;
  observedAt: string;
  stale: boolean;
}

export interface CoffeeTimingPolicy {
  source: "home-assistant";
  warmupDurationSeconds: number | null;
  longRunningThresholdSeconds: number | null;
  fetchedAt: string | null;
  stale: boolean;
  sourceAvailable: boolean;
  sourceRevision: string | null;
}

export interface CoffeeData {
  machine: CoffeeMachineState;
  timingPolicy: CoffeeTimingPolicy;
}

export interface KettleData {
  stage: KettleStage;
  entityId: "water_heater.chainik";
  authority: "home-assistant";
  observedAt: string;
}

export interface ServicePresentation {
  category: ServiceCategory;
  group: ServiceGroup;
  overview: ServiceOverviewPlacement;
  priority: number;
  environment?: string | null;
  freshnessLabel?: string | null;
  latencyMs?: number | null;
  incidents?: number;
  role?: "home-authority" | "timing-policy" | null;
}

export interface ServiceSnapshot {
  id: string;
  title: string;
  enabled: boolean;
  dataContract: string;
  health: HealthState;
  source: SourceMode;
  summary: string;
  actions: ActionDescriptor[];
  data: CoffeeData | KettleData | Record<string, unknown>;
  presentation?: ServicePresentation;
}

export interface DashboardSnapshot {
  revision: number;
  generatedAt: string;
  mode: PanelMode;
  fixtureScenario: string | null;
  services: ServiceSnapshot[];
}

export interface CoffeeTimingSettings {
  schemaVersion: 1;
  source: "home-assistant";
  transport: "alice-tg-bot";
  revision: string;
  observedAt: string;
  warmupMinutes: number;
  longRunningMinutes: number;
  sourceMode: SourceMode;
  writesEnabled: boolean;
}

export interface CoffeeNotificationEventSettings {
  enabled: boolean;
  channels: {
    telegram: boolean;
    iphone: boolean;
  };
}

export interface CoffeeNotificationSettings {
  schemaVersion: 1;
  source: "alice-tg-bot";
  revision: string;
  updatedAt: string | null;
  warmup: CoffeeNotificationEventSettings;
  longRunning: CoffeeNotificationEventSettings;
  sourceMode: SourceMode;
  writesEnabled: boolean;
}

export interface CoffeeActionResponse {
  schemaVersion: 1;
  authority: "home-assistant";
  action: "turn_on" | "turn_off";
  requestId: string;
  confirmedState: "on" | "off";
  alreadyInState: boolean;
  observedAt: string | null;
}

export interface WidgetManifest {
  id: string;
  kind: "specialized" | "generic";
  supportedDataContracts: string[];
  settingsSchema: Record<string, unknown>;
  defaultSection: "overview" | "home" | "services" | "new-items";
  defaultPriority: number;
  visualAsset?: {
    type: "image";
    sourcePath: string;
    fit: "contain" | "cover";
    alt: string;
  };
}

export interface MaterializedWidget {
  id: string;
  serviceId: string;
  manifestId: string;
  section: "overview" | "home" | "new-items" | "services";
  preserved: boolean;
}
