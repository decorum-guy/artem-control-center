export type PanelMode = "fixtures" | "read_only" | "integration_test" | "production";
export type HealthState = "healthy" | "degraded" | "offline" | "stale";
export type SourceMode = "live" | "cached" | "fixture" | "stale" | "unavailable";

export type InterfaceCopyNavigationKey =
  | "overview"
  | "weather"
  | "home"
  | "services"
  | "calendar"
  | "tasks"
  | "reminders"
  | "backups"
  | "apps"
  | "system"
  | "settings";
export type InterfaceCopyPageKey = InterfaceCopyNavigationKey;
export type InterfaceCopyField =
  | `navigation.${InterfaceCopyNavigationKey}`
  | "navigationGroup.planning"
  | `page.${InterfaceCopyPageKey}.title`
  | `page.${InterfaceCopyPageKey}.subtitle`;

export interface InterfaceCopyPageText {
  title: string;
  subtitle: string;
}

export interface InterfaceCopyCatalog {
  navigation: {
    overview: string;
    weather: string;
    home: string;
    services: string;
    calendar: string;
    tasks: string;
    reminders: string;
    backups: string;
    apps: string;
    system: string;
    settings: string;
  };
  navigationGroup: {
    planning: string;
  };
  page: {
    overview: InterfaceCopyPageText;
    weather: InterfaceCopyPageText;
    home: InterfaceCopyPageText;
    services: InterfaceCopyPageText;
    calendar: InterfaceCopyPageText;
    tasks: InterfaceCopyPageText;
    reminders: InterfaceCopyPageText;
    backups: InterfaceCopyPageText;
    apps: InterfaceCopyPageText;
    system: InterfaceCopyPageText;
    settings: InterfaceCopyPageText;
  };
}

export type InterfaceCopyFieldOverrides<T> = {
  [Key in keyof T]?: string | null;
};

export interface InterfaceCopyOverrides {
  navigation: InterfaceCopyFieldOverrides<InterfaceCopyCatalog["navigation"]>;
  navigationGroup: { planning?: string | null };
  page: {
    overview: Partial<InterfaceCopyPageText>;
    weather: Partial<InterfaceCopyPageText>;
    home: Partial<InterfaceCopyPageText>;
    services: Partial<InterfaceCopyPageText>;
    calendar: Partial<InterfaceCopyPageText>;
    tasks: Partial<InterfaceCopyPageText>;
    reminders: Partial<InterfaceCopyPageText>;
    backups: Partial<InterfaceCopyPageText>;
    apps: Partial<InterfaceCopyPageText>;
    system: Partial<InterfaceCopyPageText>;
    settings: Partial<InterfaceCopyPageText>;
  };
}

export interface InterfaceCopySettings {
  schemaVersion: "interface.copy-settings.v1";
  revision: number;
  /** 0 only when persisted data is unavailable and resetAll is recovery-gated. */
  recoveryRevision: number | null;
  updatedAt: string;
  defaults: InterfaceCopyCatalog;
  overrides: InterfaceCopyOverrides;
  effective: InterfaceCopyCatalog;
  available: boolean;
  warnings: ("stored_copy_settings_unavailable")[];
  writesEnabled: boolean;
}

export interface InterfaceCopyPatch {
  expectedRevision: number;
  field?: InterfaceCopyField;
  value?: string | null;
  resetAll?: boolean;
}
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
  | "sleeping"
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

export type DiagnosticsProblemState =
  | "offline"
  | "degraded"
  | "stale"
  | "error"
  | "recovered";
export type DiagnosticsSeverity = "info" | "warning" | "error";

export interface DiagnosticsProblem {
  id: string;
  subsystem: string;
  severity: DiagnosticsSeverity;
  state: DiagnosticsProblemState;
  current: boolean;
  summary: string;
  firstObservedAt: string | null;
  lastObservedAt: string;
  lastHealthyAt: string | null;
  freshness: string | null;
  correlationCode: string | null;
}

export interface DiagnosticsTransition {
  problemId: string;
  subsystem: string;
  fromState: DiagnosticsProblemState | null;
  toState: DiagnosticsProblemState;
  current: boolean;
  observedAt: string;
  summary: string;
}

export interface DiagnosticsCollectorStatus {
  collector: string;
  status: "ok" | "error";
  code: string | null;
}

export interface DiagnosticsCalendarQuery {
  scopeType: "ACTUAL_REQUEST_RANGE" | "PROJECTION_SCOPE";
  fromDate: string;
  toDate: string;
  requestFromUtc: string | null;
  requestToUtc: string | null;
  view: "today" | "agenda" | null;
  timezone: string;
  observedAt: string;
  lastSyncedAt: string | null;
  resultStatus: "success_nonempty" | "success_empty" | "degraded" | "error" | "unavailable";
  itemCount: number;
  sourceCount: number;
  calendarCount: number;
  sourceStatus: string | null;
  cacheUsed: boolean;
  fallbackUsed: boolean;
  projectionStatus: "current" | "cached" | "empty" | "unavailable";
  projectionScope: string | null;
  providers: DiagnosticsProviderSummary[];
}

export interface DiagnosticsProviderSummary {
  id: string;
  kind: "native" | "external";
  provider: "local" | "icloud";
  label: string;
  status: string;
  configured: boolean;
  lastSyncedAt: string | null;
  observedAt: string | null;
  calendarCount: number;
}

export interface DiagnosticsPlanningSummary {
  schemaVersion: string | null;
  sourceStatus: string | null;
  lastSyncedAt: string | null;
  staleAfter: string | null;
  remindersCount: number;
  tasksCount: number;
  calendarCount: number;
  cacheUsed: boolean;
  providers: DiagnosticsProviderSummary[];
}

export interface DiagnosticsMutationGates {
  writesEnabled: boolean;
  coffeeActionsEnabled: boolean;
  coffeeTimingWritesEnabled: boolean;
  coffeeNotificationWritesEnabled: boolean;
  planningReminderMutationsEnabled: boolean;
  planningTaskMutationsEnabled: boolean;
  planningCalendarMutationsEnabled: boolean;
}

export interface DiagnosticsReport {
  schemaVersion: "diagnostics.v1";
  generatedAt: string;
  buildRevision: string;
  mode: PanelMode;
  snapshotRevision: number;
  problems: DiagnosticsProblem[];
  recentTransitions: DiagnosticsTransition[];
  collectorStatus: DiagnosticsCollectorStatus[];
  planning: DiagnosticsPlanningSummary;
  calendar: DiagnosticsCalendarQuery;
  calendarReads: DiagnosticsCalendarQuery[];
  mutationGates: DiagnosticsMutationGates;
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
export type PlanningCapability = "read" | "create" | "update" | "complete" | "cancel" | "delete";

export interface PlanningCapabilitySet {
  read: boolean;
  create: boolean;
  update: boolean;
  complete: boolean;
  cancel: boolean;
  delete: boolean;
}

/** Frontend-safe calendar identity. Provider transport and credentials never cross this boundary. */
export interface PlanningCalendarIdentity {
  providerId: string;
  providerLabel: string;
  calendarId: string;
  calendarLabel: string;
}

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
  /** Optional canonical reminder details; omitted by older read projections. */
  notes?: string | null;
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
  notes: string | null;
  priority: PlanningTaskPriority;
  status: PlanningTaskStatus;
  dueDate: string | null;
  dueTime: string | null;
  timezone: string | null;
  projectId: string | null;
  sourceRef: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningCalendarEvent {
  id: string;
  version: number;
  source: PlanningSource;
  sourceLabel: string;
  calendarIdentity?: PlanningCalendarIdentity | null;
  title: string;
  notes: string | null;
  location: string | null;
  allDay: boolean;
  timezone: string;
  syncState: PlanningEventSyncState;
  localOnlyMutable: boolean;
  startAtUtc: string | null;
  endAtUtc: string | null;
  startDate: string | null;
  endDateExclusive: string | null;
  deletedAt: string | null;
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

export interface PlanningTaskCapabilities {
  create: boolean;
  edit: boolean;
  complete: boolean;
  archive: boolean;
}

export interface PlanningCalendarCapabilities {
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface PlanningCapabilities {
  create: boolean;
  edit: boolean;
  complete: boolean;
  cancel: boolean;
  delete: boolean;
  voice: boolean;
  providerSync: boolean;
  tasks: PlanningTaskCapabilities;
  calendar: PlanningCalendarCapabilities;
}

export type PlanningProviderFreshnessStatus = "current" | "stale" | "error" | "not_configured" | "disabled";

export interface PlanningCalendarSourceCalendar {
  id: string;
  label: string;
  color: string | null;
  enabled: boolean;
  status: PlanningProviderFreshnessStatus;
  lastSyncedAt: string | null;
  observedAt: string | null;
}

/** Browser-safe provider source projection; upstream account and transport identities are dropped. */
export interface PlanningProviderStatus {
  id: string;
  kind: "native" | "external";
  provider: "local" | "icloud";
  label: string;
  status: PlanningProviderFreshnessStatus;
  configured: boolean;
  lastSyncedAt: string | null;
  observedAt: string | null;
  calendars: PlanningCalendarSourceCalendar[];
}

export type PlanningCalendarSource = PlanningProviderStatus;

/** Panel-owned display preferences. These never alter provider metadata. */
export interface CalendarDisplayColorOverride {
  providerId: string;
  calendarId: string;
  color: string;
}

export interface CalendarDisplayPreferences {
  schemaVersion: "calendar.display-preferences.v1";
  revision: number;
  updatedAt: string;
  overrides: CalendarDisplayColorOverride[];
  available: boolean;
  warnings: "stored_preferences_unavailable"[];
  writesEnabled: boolean;
}

export interface PlanningSnapshot {
  schemaVersion: "planning.panel.v1";
  generatedAt: string;
  sourceStatus: PlanningSourceStatus;
  /** Server/deployment writer gate, distinct from profile permissions. */
  reminderMutationsEnabled?: boolean;
  /** Server/deployment task writer gate, distinct from profile permissions. */
  taskMutationsEnabled?: boolean;
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
    /** Present in current projections; omitted only by older cached snapshots. */
    undated?: PlanningTask[];
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
