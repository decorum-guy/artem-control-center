from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

PanelMode = Literal["fixtures", "read_only", "integration_test", "production"]
HealthState = Literal["healthy", "degraded", "offline", "stale"]


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
