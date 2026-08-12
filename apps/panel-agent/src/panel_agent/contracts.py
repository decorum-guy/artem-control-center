from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

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
