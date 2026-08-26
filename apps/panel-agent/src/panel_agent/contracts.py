import re
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .planning import PlanningProjection

PanelMode = Literal["fixtures", "read_only", "integration_test", "production"]
HealthState = Literal["healthy", "degraded", "offline", "stale"]
SourceMode = Literal["live", "cached", "fixture", "stale", "unavailable"]


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
