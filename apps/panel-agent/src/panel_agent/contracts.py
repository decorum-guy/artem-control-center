import re
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .planning import PlanningProjection

PanelMode = Literal["fixtures", "read_only", "integration_test", "production"]
HealthState = Literal["healthy", "degraded", "offline", "stale"]
SourceMode = Literal["live", "cached", "fixture", "stale", "unavailable"]
InterfaceCopyNavigationKey = Literal[
    "overview",
    "weather",
    "home",
    "services",
    "calendar",
    "tasks",
    "reminders",
    "coffeeDiary",
    "backups",
    "apps",
    "system",
    "settings",
]
InterfaceCopyPageKey = InterfaceCopyNavigationKey
InterfaceCopyField = Literal[
    "navigation.overview",
    "navigation.weather",
    "navigation.home",
    "navigation.services",
    "navigation.calendar",
    "navigation.tasks",
    "navigation.reminders",
    "navigation.coffeeDiary",
    "navigation.backups",
    "navigation.apps",
    "navigation.system",
    "navigation.settings",
    "navigationGroup.planning",
    "page.overview.title",
    "page.overview.subtitle",
    "page.weather.title",
    "page.weather.subtitle",
    "page.home.title",
    "page.home.subtitle",
    "page.services.title",
    "page.services.subtitle",
    "page.calendar.title",
    "page.calendar.subtitle",
    "page.tasks.title",
    "page.tasks.subtitle",
    "page.reminders.title",
    "page.reminders.subtitle",
    "page.backups.title",
    "page.backups.subtitle",
    "page.apps.title",
    "page.apps.subtitle",
    "page.system.title",
    "page.system.subtitle",
    "page.settings.title",
    "page.settings.subtitle",
]


class ActionDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    enabled: bool
    risk: Literal["low", "medium", "high"]


class ServicePresentation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: Literal[
        "home-device",
        "home-infrastructure",
        "work",
        "personal-infrastructure",
        "system",
        "external",
    ]
    group: Literal[
        "AVALAR",
        "Home infrastructure",
        "Personal infrastructure",
        "System",
        "External services",
    ]
    overview: Literal["primary", "quick-control", "aggregate", "incident-only", "none"]
    priority: int = Field(ge=0, le=1000)
    environment: Optional[str] = None
    freshnessLabel: Optional[str] = None
    latencyMs: Optional[int] = Field(default=None, ge=0)
    incidents: int = Field(default=0, ge=0)
    role: Optional[Literal["home-authority", "timing-policy"]] = None


class ServiceSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,79}$")
    title: str = Field(min_length=1, max_length=100)
    enabled: bool = True
    dataContract: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]+\.v[0-9]+$")
    health: HealthState
    source: SourceMode = "fixture"
    summary: str = Field(max_length=240)
    actions: List[ActionDescriptor] = []
    data: Dict[str, Any] = {}
    presentation: Optional[ServicePresentation] = None


DiagnosticsProblemState = Literal[
    "offline",
    "degraded",
    "stale",
    "error",
    "recovered",
]
DiagnosticsSeverity = Literal["info", "warning", "error"]


class DiagnosticsProblem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=120, pattern=r"^[a-z0-9][a-z0-9._:-]+$")
    subsystem: str = Field(min_length=1, max_length=80)
    severity: DiagnosticsSeverity
    state: DiagnosticsProblemState
    current: bool
    summary: str = Field(min_length=1, max_length=240)
    firstObservedAt: Optional[str] = None
    lastObservedAt: str
    lastHealthyAt: Optional[str] = None
    freshness: Optional[str] = Field(default=None, max_length=120)
    correlationCode: Optional[str] = Field(default=None, max_length=120)


class DiagnosticsTransition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    problemId: str = Field(min_length=1, max_length=120)
    subsystem: str = Field(min_length=1, max_length=80)
    fromState: Optional[DiagnosticsProblemState] = None
    toState: DiagnosticsProblemState
    current: bool
    observedAt: str
    summary: str = Field(min_length=1, max_length=240)


class DiagnosticsCollectorStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    collector: str = Field(min_length=1, max_length=80)
    status: Literal["ok", "error"]
    code: Optional[str] = Field(default=None, max_length=120)


class DiagnosticsProviderSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    kind: Literal["native", "external"]
    provider: Literal["local", "icloud"]
    label: str = Field(min_length=1, max_length=128)
    status: str = Field(min_length=1, max_length=32)
    configured: bool
    lastSyncedAt: Optional[str] = None
    observedAt: Optional[str] = None
    calendarCount: int = Field(ge=0)


class DiagnosticsCalendarQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scopeType: Literal["ACTUAL_REQUEST_RANGE", "PROJECTION_SCOPE"]
    fromDate: str
    toDate: str
    requestFromUtc: Optional[str] = None
    requestToUtc: Optional[str] = None
    view: Optional[Literal["today", "agenda"]] = None
    timezone: str = Field(min_length=1, max_length=64)
    observedAt: str
    lastSyncedAt: Optional[str] = None
    resultStatus: Literal["success_nonempty", "success_empty", "degraded", "error", "unavailable"]
    itemCount: int = Field(ge=0)
    sourceCount: int = Field(ge=0)
    calendarCount: int = Field(ge=0)
    sourceStatus: Optional[str] = Field(default=None, max_length=32)
    cacheUsed: bool = False
    fallbackUsed: bool = False
    projectionStatus: Literal["current", "cached", "empty", "unavailable"]
    projectionScope: Optional[str] = Field(default=None, max_length=64)
    providers: List[DiagnosticsProviderSummary] = Field(default_factory=list, max_length=4)


class DiagnosticsPlanningSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Optional[str] = None
    sourceStatus: Optional[str] = Field(default=None, max_length=32)
    lastSyncedAt: Optional[str] = None
    staleAfter: Optional[str] = None
    remindersCount: int = Field(ge=0)
    tasksCount: int = Field(ge=0)
    calendarCount: int = Field(ge=0)
    cacheUsed: bool = False
    providers: List[DiagnosticsProviderSummary] = Field(default_factory=list)


class DiagnosticsMutationGates(BaseModel):
    model_config = ConfigDict(extra="forbid")

    writesEnabled: bool
    coffeeActionsEnabled: bool
    coffeeTimingWritesEnabled: bool
    coffeeNotificationWritesEnabled: bool
    planningReminderMutationsEnabled: bool
    planningTaskMutationsEnabled: bool
    planningCalendarMutationsEnabled: bool


class DiagnosticsReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["diagnostics.v1"]
    generatedAt: str
    buildRevision: str = Field(min_length=1, max_length=80)
    mode: PanelMode
    snapshotRevision: int = Field(ge=0)
    problems: List[DiagnosticsProblem] = Field(default_factory=list, max_length=64)
    recentTransitions: List[DiagnosticsTransition] = Field(default_factory=list, max_length=32)
    collectorStatus: List[DiagnosticsCollectorStatus] = Field(default_factory=list, max_length=16)
    planning: DiagnosticsPlanningSummary
    calendar: DiagnosticsCalendarQuery
    calendarReads: List[DiagnosticsCalendarQuery] = Field(default_factory=list, max_length=32)
    mutationGates: DiagnosticsMutationGates


class DashboardSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int
    generatedAt: str
    mode: PanelMode
    fixtureScenario: Optional[str]
    services: List[ServiceSnapshot]
    planning: Optional[PlanningProjection] = None


class InterfaceCopyPageText(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: str = Field(min_length=1, max_length=96)
    subtitle: str = Field(max_length=240)


class InterfaceCopyNavigation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    overview: str = Field(min_length=1, max_length=48)
    weather: str = Field(min_length=1, max_length=48)
    home: str = Field(min_length=1, max_length=48)
    services: str = Field(min_length=1, max_length=48)
    calendar: str = Field(min_length=1, max_length=48)
    tasks: str = Field(min_length=1, max_length=48)
    reminders: str = Field(min_length=1, max_length=48)
    coffeeDiary: str = Field(min_length=1, max_length=48)
    backups: str = Field(min_length=1, max_length=48)
    apps: str = Field(min_length=1, max_length=48)
    system: str = Field(min_length=1, max_length=48)
    settings: str = Field(min_length=1, max_length=48)


class InterfaceCopyNavigationGroup(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    planning: str = Field(min_length=1, max_length=48)


class InterfaceCopyCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    navigation: InterfaceCopyNavigation
    navigationGroup: InterfaceCopyNavigationGroup
    page: "InterfaceCopyPageCatalog"


class InterfaceCopyPageCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    overview: InterfaceCopyPageText
    weather: InterfaceCopyPageText
    home: InterfaceCopyPageText
    services: InterfaceCopyPageText
    calendar: InterfaceCopyPageText
    tasks: InterfaceCopyPageText
    reminders: InterfaceCopyPageText
    coffeeDiary: InterfaceCopyPageText
    backups: InterfaceCopyPageText
    apps: InterfaceCopyPageText
    system: InterfaceCopyPageText
    settings: InterfaceCopyPageText


InterfaceCopyCatalog.model_rebuild()


class InterfaceCopyNavigationOverrides(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    overview: Optional[str] = Field(default=None, max_length=48)
    weather: Optional[str] = Field(default=None, max_length=48)
    home: Optional[str] = Field(default=None, max_length=48)
    services: Optional[str] = Field(default=None, max_length=48)
    calendar: Optional[str] = Field(default=None, max_length=48)
    tasks: Optional[str] = Field(default=None, max_length=48)
    reminders: Optional[str] = Field(default=None, max_length=48)
    coffeeDiary: Optional[str] = Field(default=None, max_length=48)
    backups: Optional[str] = Field(default=None, max_length=48)
    apps: Optional[str] = Field(default=None, max_length=48)
    system: Optional[str] = Field(default=None, max_length=48)
    settings: Optional[str] = Field(default=None, max_length=48)


class InterfaceCopyNavigationGroupOverrides(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    planning: Optional[str] = Field(default=None, max_length=48)


class InterfaceCopyPageTextOverrides(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: Optional[str] = Field(default=None, max_length=96)
    subtitle: Optional[str] = Field(default=None, max_length=240)


class InterfaceCopyPageOverrides(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    overview: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    weather: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    home: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    services: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    calendar: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    tasks: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    reminders: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    coffeeDiary: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    backups: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    apps: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    system: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)
    settings: InterfaceCopyPageTextOverrides = Field(default_factory=InterfaceCopyPageTextOverrides)


class InterfaceCopyOverrides(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    navigation: InterfaceCopyNavigationOverrides = Field(default_factory=InterfaceCopyNavigationOverrides)
    navigationGroup: InterfaceCopyNavigationGroupOverrides = Field(default_factory=InterfaceCopyNavigationGroupOverrides)
    page: InterfaceCopyPageOverrides = Field(default_factory=InterfaceCopyPageOverrides)


class InterfaceCopySettingsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schemaVersion: Literal["interface.copy-settings.v1"]
    revision: int = Field(ge=0)
    # Invalid persisted data cannot provide a trusted revision.  In that
    # state the API exposes the deterministic recovery revision 0 instead.
    recoveryRevision: Optional[int] = Field(default=None, ge=0)
    updatedAt: str
    defaults: InterfaceCopyCatalog
    overrides: InterfaceCopyOverrides
    effective: InterfaceCopyCatalog
    available: bool
    warnings: List[Literal["stored_copy_settings_unavailable"]] = Field(default_factory=list, max_length=1)
    writesEnabled: bool = False

    @model_validator(mode="after")
    def _recovery_shape(self) -> "InterfaceCopySettingsResponse":
        if self.available and self.recoveryRevision is not None:
            raise ValueError("recoveryRevision is only valid for unavailable stores")
        if not self.available and self.recoveryRevision != 0:
            raise ValueError("unavailable stores require recoveryRevision 0")
        return self


class InterfaceCopyPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    expectedRevision: int = Field(ge=0, le=2_147_483_647)
    field: Optional[InterfaceCopyField] = None
    value: Optional[str] = Field(default=None, max_length=240)
    resetAll: bool = False

    @model_validator(mode="after")
    def _shape(self) -> "InterfaceCopyPatch":
        supplied_value = "value" in self.model_fields_set
        if self.resetAll:
            if self.field is not None or supplied_value:
                raise ValueError("resetAll cannot be combined with field or value")
        elif self.field is None or not supplied_value:
            raise ValueError("field and value are required unless resetAll is true")
        return self


class CoffeeTimingSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    source: Literal["home-assistant"]
    transport: Literal["alice-tg-bot"]
    revision: str
    observedAt: str
    warmupMinutes: int = Field(ge=1)
    longRunningMinutes: int = Field(ge=1)
    sourceMode: SourceMode = "live"
    writesEnabled: bool = False


class CoffeeTimingPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expectedRevision: str = Field(min_length=1, max_length=256)
    warmupMinutes: Optional[int] = Field(default=None, ge=1)
    longRunningMinutes: Optional[int] = Field(default=None, ge=1)


class NotificationChannels(BaseModel):
    model_config = ConfigDict(extra="forbid")

    telegram: bool
    iphone: bool


class CoffeeNotificationEventSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    channels: NotificationChannels


class CoffeeNotificationSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    source: Literal["alice-tg-bot"]
    revision: str
    updatedAt: Optional[str]
    warmup: CoffeeNotificationEventSettings
    longRunning: CoffeeNotificationEventSettings
    sourceMode: SourceMode = "live"
    writesEnabled: bool = False


class NotificationChannelsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    telegram: Optional[bool] = None
    iphone: Optional[bool] = None


class CoffeeNotificationEventPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: Optional[bool] = None
    channels: Optional[NotificationChannelsPatch] = None


class CoffeeNotificationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expectedRevision: str = Field(min_length=1, max_length=256)
    warmup: Optional[CoffeeNotificationEventPatch] = None
    longRunning: Optional[CoffeeNotificationEventPatch] = None


ReminderEndpoint = Literal["alice", "jarvis"]
ReminderPhoneChannel = Literal["telegram", "home_assistant"]
ReminderChannelStatus = Literal["available", "not_configured", "unavailable"]


class ReminderChannelHealth(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    status: ReminderChannelStatus
    code: Optional[str] = Field(default=None, max_length=128)


class ReminderChannelHealthMap(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    alice: ReminderChannelHealth
    jarvis: ReminderChannelHealth


class ReminderPhoneHealthMap(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    telegram: ReminderChannelHealth
    home_assistant: ReminderChannelHealth


class ReminderDeliveryChannelHealth(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    spoken: ReminderChannelHealthMap
    phone: ReminderPhoneHealthMap


class ReminderDeliverySettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schemaVersion: Literal["reminder.delivery-settings.v1"]
    revision: int = Field(ge=0)
    updatedAt: str
    spokenEndpoint: ReminderEndpoint
    phoneChannels: List[ReminderPhoneChannel] = Field(min_length=1, max_length=2)
    channelHealth: ReminderDeliveryChannelHealth
    sourceMode: SourceMode = "live"
    writesEnabled: bool = False

    @field_validator("phoneChannels")
    @classmethod
    def _unique_channels(cls, value: List[ReminderPhoneChannel]) -> List[ReminderPhoneChannel]:
        if len(set(value)) != len(value):
            raise ValueError("phoneChannels must not contain duplicates")
        return value


class ReminderDeliveryPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    expectedRevision: int = Field(ge=0, le=2_147_483_647)
    spokenEndpoint: ReminderEndpoint
    phoneChannels: List[ReminderPhoneChannel] = Field(min_length=1, max_length=2)

    @field_validator("phoneChannels")
    @classmethod
    def _unique_channels(cls, value: List[ReminderPhoneChannel]) -> List[ReminderPhoneChannel]:
        if len(set(value)) != len(value):
            raise ValueError("phoneChannels must not contain duplicates")
        return value


class CoffeeActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["turn_on", "turn_off"]
    requestId: str = Field(pattern=r"^[A-Za-z0-9._:-]{8,128}$")


class CoffeeActionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    authority: Literal["home-assistant"]
    action: Literal["turn_on", "turn_off"]
    requestId: str
    confirmedState: Literal["on", "off"]
    alreadyInState: bool
    observedAt: Optional[str]


CoffeeDelayedStartStatus = Literal[
    "pending",
    "executing",
    "succeeded",
    "failed",
    "cancelled",
]


class CoffeeDelayedStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    delayMinutes: int = Field(ge=1, le=120)
    requestId: str = Field(pattern=r"^[A-Za-z0-9._:-]{8,128}$")


class CoffeeDelayedStartRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["coffee.delayed-start.v1"]
    scheduleId: str = Field(min_length=1, max_length=80)
    requestId: str = Field(pattern=r"^[A-Za-z0-9._:-]{8,128}$")
    delayMinutes: int = Field(ge=1, le=120)
    status: CoffeeDelayedStartStatus
    dueAt: str
    createdAt: str
    updatedAt: str
    failureCode: Optional[str] = Field(default=None, max_length=120)


class CoffeeDelayedStartResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    schedule: Optional[CoffeeDelayedStartRecord]
    available: bool
    writesEnabled: bool


_CALENDAR_DISPLAY_ID = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"
_CALENDAR_DISPLAY_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


class CalendarDisplayColorOverride(BaseModel):
    """Safe identity pair and Panel-only canonical colour."""

    model_config = ConfigDict(extra="forbid", strict=True)

    providerId: str = Field(min_length=1, max_length=128, pattern=_CALENDAR_DISPLAY_ID)
    calendarId: str = Field(min_length=1, max_length=128, pattern=_CALENDAR_DISPLAY_ID)
    color: str = Field(min_length=7, max_length=7)

    @field_validator("color")
    @classmethod
    def _color(cls, value: str) -> str:
        if _CALENDAR_DISPLAY_COLOR.fullmatch(value) is None:
            raise ValueError("calendar display colour must be #RRGGBB")
        return value.upper()


class CalendarDisplayColorPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    expectedRevision: int = Field(ge=0, le=2_147_483_647)
    providerId: str = Field(min_length=1, max_length=128, pattern=_CALENDAR_DISPLAY_ID)
    calendarId: str = Field(min_length=1, max_length=128, pattern=_CALENDAR_DISPLAY_ID)
    color: Optional[str] = Field(default=None, min_length=7, max_length=7)

    @field_validator("color")
    @classmethod
    def _optional_color(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        if _CALENDAR_DISPLAY_COLOR.fullmatch(value) is None:
            raise ValueError("calendar display colour must be #RRGGBB")
        return value.upper()


class CalendarDisplayPreferencesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schemaVersion: Literal["calendar.display-preferences.v1"]
    revision: int = Field(ge=0)
    updatedAt: str
    overrides: List[CalendarDisplayColorOverride] = Field(default_factory=list, max_length=128)
    available: bool
    warnings: List[Literal["stored_preferences_unavailable"]] = Field(default_factory=list, max_length=1)
    writesEnabled: bool = False


OwnerFacingDeviceKey = Literal["kettle"]


class DeviceVisibilityPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    expectedRevision: int = Field(ge=0, le=2_147_483_647)
    deviceKey: OwnerFacingDeviceKey
    visible: bool


class DeviceVisibilityState(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    key: OwnerFacingDeviceKey
    label: str = Field(min_length=1, max_length=100)
    defaultVisible: bool
    visible: bool


class DeviceVisibilitySettingsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schemaVersion: Literal["device.visibility.v1"]
    revision: int = Field(ge=0)
    updatedAt: str
    devices: List[DeviceVisibilityState] = Field(default_factory=list, max_length=16)
    available: bool
    warnings: List[Literal["stored_device_visibility_unavailable"]] = Field(default_factory=list, max_length=1)
    writesEnabled: bool = False


class CapabilityPatch(BaseModel):
    """The browser may name only an explicit registry capability ID."""

    model_config = ConfigDict(extra="forbid", strict=True)

    expectedRevision: int = Field(ge=0, le=2_147_483_647)
    capabilityId: Literal[
        "calendar_display_colors",
        "overview_layout_editor",
        "planning_overview",
        "planning_tasks_route",
        "planning_calendar_route",
        "planning_reminders_route",
    ]
    enabled: Optional[bool] = None


class OverviewPlacement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: int = Field(strict=True, ge=0, le=12)
    y: int = Field(strict=True, ge=0, le=10_000)
    w: int = Field(strict=True, ge=1, le=12)
    h: int = Field(strict=True, ge=1, le=8)


class OverviewLayoutItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    instanceId: str = Field(strict=True, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    widgetType: str = Field(strict=True, min_length=1, max_length=80, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    visibility: Literal["visible", "hidden"] = "visible"
    placement: OverviewPlacement
    sizeVariant: str = Field(strict=True, min_length=1, max_length=24, pattern=r"^[a-z0-9-]+$")
    config: Dict[str, Any] = Field(default_factory=dict)


class OverviewLayoutPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: List[OverviewLayoutItemRequest] = Field(min_length=1, max_length=32)


class OverviewUnplacedWidget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    instanceId: str = Field(min_length=1, max_length=80)
    widgetType: str = Field(min_length=1, max_length=80)
    reason: str = Field(min_length=1, max_length=240)


class OverviewLayoutResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["overview.layout.v2"]
    profileId: Literal["samsung-control"]
    presetId: Literal["overview.default"]
    presetVersion: Literal[2]
    revision: int = Field(ge=0)
    viewportClass: Literal["landscape-12"]
    updatedAt: str
    items: List[OverviewLayoutItemRequest]
    warnings: List[str] = Field(default_factory=list)
    unplaced: List[OverviewUnplacedWidget] = Field(default_factory=list)
    writesEnabled: bool = False
