from __future__ import annotations

from typing import Awaitable, Callable, List

from .contracts import PanelMode, ServiceSnapshot
from .alice_control import AliceControlClient
from .home_assistant import HomeAssistantAdapter
from .http_integrations import HttpIntegrationAdapter
from .planning import PlanningProjection
from .planning_adapter import PlanningAdapter
from .planning_fixtures import PlanningFixtureTransport, fixture_reference_datetime
from .settings import IntegrationSettings
from .ssh_details import AvalarSshDetailsAdapter


class IntegrationRuntime:
    def __init__(
        self,
        settings: IntegrationSettings,
        *,
        mode: PanelMode = "read_only",
    ) -> None:
        self.settings = settings
        self.home_assistant = HomeAssistantAdapter(settings, panel_mode=mode)
        self.alice_control = AliceControlClient(settings)
        self.avalar_ssh = AvalarSshDetailsAdapter(settings)
        self.http = HttpIntegrationAdapter(
            settings,
            details_provider=self.avalar_ssh,
        )
        fixture_planning = (
            mode in {"fixtures", "integration_test"}
            and settings.panel_planning_enabled
        )
        planning_transport = (
            PlanningFixtureTransport(settings.panel_planning_fixture_scenario)
            if fixture_planning
            else None
        )
        planning_wall_clock = fixture_reference_datetime if fixture_planning else None
        self.planning = PlanningAdapter(
            settings,
            transport=planning_transport,
            wall_clock=planning_wall_clock,
        )

    def set_snapshot_callback(
        self,
        callback: Callable[[], Awaitable[None]] | None,
    ) -> None:
        self.home_assistant.set_on_change(callback)
        self.http.set_on_change(callback)
        self.planning.set_on_change(callback)

    async def start(self) -> None:
        await self.home_assistant.start()
        await self.avalar_ssh.start()
        await self.http.start()
        await self.planning.start()

    async def start_planning(self) -> None:
        """Start only the feature-gated Planning adapter in fixture modes."""

        await self.planning.start()

    async def close(self) -> None:
        await self.http.close()
        await self.avalar_ssh.close()
        await self.home_assistant.close()
        await self.planning.close()

    def services(self) -> List[ServiceSnapshot]:
        services = self.home_assistant.services() + self.http.services()
        return sorted(
            services,
            key=lambda service: service.presentation.priority
            if service.presentation
            else 0,
            reverse=True,
        )

    def planning_snapshot(self) -> PlanningProjection | None:
        return self.planning.projection
