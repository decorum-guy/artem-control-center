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

export type RogG703DeviceStatus =
  | "online"
  | "offline"
  | "waking"
  | "hibernating"
  | "unavailable";

export interface RogG703Data {
  targetId: "rog_g703gi";
  status: RogG703DeviceStatus;
  observedAt: string;
  lastTransitionAt: string;
  lastError: string | null;
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

export type PlanningSourceStatus = "current" | "stale" | "offline" | "degraded";
export type PlanningSource =
  | "alice"
  | "telegram"
  | "panel-agent"
  | "operator"
  | "ticktick"
  | "calendar-provider"
  | "system";
export type PlanningReminderStatus = "pending" | "due" | "completed" | "cancelled";
export type PlanningDeliveryState = "not_due" | "queued" | "retrying" | "delivered" | "failed";
export type PlanningTaskPriority = "none" | "low" | "normal" | "high";
export type PlanningTaskStatus = "open" | "completed" | "archived";
export type PlanningEventSyncState =
  | "local_only"
  | "pending"
  | "synced"
  | "stale"
  | "conflict"
  | "error";

export interface PlanningReminder {
  id: string;
  version: number;
  source: PlanningSource;
  sourceLabel: string;
  title: string;
  dueAtUtc: string;
  timezone: string;
  status: PlanningReminderStatus;
  deliveryState: PlanningDeliveryState;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningTask {
  id: string;
  version: number;
  source: PlanningSource;
  sourceLabel: string;
  title: string;
  priority: PlanningTaskPriority;
  status: PlanningTaskStatus;
  dueDate: string | null;
  dueTime: string | null;
  timezone: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningCalendarEvent {
  id: string;
  version: number;
  source: PlanningSource;
  sourceLabel: string;
  title: string;
  allDay: boolean;
  timezone: string;
  syncState: PlanningEventSyncState;
  startAtUtc: string | null;
  endAtUtc: string | null;
  startDate: string | null;
  endDateExclusive: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningProject {
  id: string;
  version: number;
  source: PlanningSource;
  sourceLabel: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningConflict {
  id: string;
  eventIds: string[];
  source: "system";
  sourceLabel: "Panel Agent";
  startAtUtc: string | null;
  endAtUtc: string | null;
}

export interface PlanningCapabilities {
  create: boolean;
  edit: boolean;
  complete: boolean;
  cancel: boolean;
  delete: boolean;
  voice: boolean;
  providerSync: boolean;
}

export interface PlanningProviderStatus {
  id: "native-planning";
  label: "Local Planning";
  status: "local_only" | "not_configured" | "degraded" | "offline";
  configured: boolean;
  lastSyncedAt: string | null;
}

export interface PlanningSnapshot {
  schemaVersion: "planning.panel.v1";
  generatedAt: string;
  sourceStatus: PlanningSourceStatus;
  lastSyncedAt: string | null;
  staleAfter: string | null;
  reminders: {
    upcoming: PlanningReminder[];
    overdue: PlanningReminder[];
    deliveryFailures: PlanningReminder[];
  };
  tasks: {
    today: PlanningTask[];
    overdue: PlanningTask[];
    upcoming: PlanningTask[];
    projects: PlanningProject[];
  };
  calendar: {
    today: PlanningCalendarEvent[];
    upcoming: PlanningCalendarEvent[];
    conflicts: PlanningConflict[];
  };
  capabilities: PlanningCapabilities;
  providerStatuses: PlanningProviderStatus[];
}

export interface DashboardSnapshot {
  revision: number;
  generatedAt: string;
  mode: PanelMode;
  fixtureScenario: string | null;
  services: ServiceSnapshot[];
  planning?: PlanningSnapshot | null;
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

/**
 * Code-owned Overview V2 layout vocabulary. These types intentionally do not
 * contain persistence, data-binding, endpoint, or action configuration.
 */
export type OverviewWidgetType =
  | "home.coffee-machine"
  | "system.rog-g703-operational"
  | "planning.summary"
  | "home.quick-actions"
  | "system.health-summary"
  | "weather.alert"
  | "planning.calendar-agenda"
  | "planning.task-list";

export type OverviewWidgetSizeVariant = "compact" | "standard" | "large" | "detail";

export interface OverviewWidgetSize {
  w: number;
  h: number;
}

export interface OverviewWidgetPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type OverviewWidgetVisibility = "visible" | "hidden";
export type OverviewConfigValue = boolean | number | string;

export interface OverviewUnplacedWidget {
  instanceId: string;
  widgetType: string;
  reason: string;
}

/**
 * A deliberately bounded, in-memory layout item. `widgetType` and
 * `sizeVariant` remain strings at this boundary so malformed/unknown input
 * can be classified safely before it reaches trusted renderers.
 */
export interface OverviewLayoutItem {
  instanceId: string;
  widgetType: string;
  sizeVariant: string;
  placement: OverviewWidgetPlacement;
  visibility?: OverviewWidgetVisibility;
  config?: Record<string, OverviewConfigValue>;
}

export interface OverviewLayoutDocument {
  schemaVersion: "overview.layout.v2";
  profileId: "samsung-control";
  presetId: "overview.default";
  presetVersion: 2;
  revision: number;
  viewportClass: "landscape-12";
  updatedAt: string;
  items: OverviewLayoutItem[];
  warnings?: string[];
  unplaced?: OverviewUnplacedWidget[];
  writesEnabled?: boolean;
}
