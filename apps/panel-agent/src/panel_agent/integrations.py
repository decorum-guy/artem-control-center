from __future__ import annotations

from typing import Awaitable, Callable, List

from .contracts import PanelMode, ServiceSnapshot
from .alice_control import AliceControlClient
from .home_assistant import HomeAssistantAdapter
from .http_integrations import HttpIntegrationAdapter
from .planning import PlanningProjection
from .planning_adapter import PlanningAdapter
from .planning_fixtures import PlanningFixtureTransport, fixture_reference_datetime
from .rog_g703_power import RogG703Device
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
        self._snapshot_callback: Callable[[], Awaitable[None]] | None = None
        self._coffee_schedule_callback: Callable[[], Awaitable[None]] | None = None
        self.home_assistant.set_on_change(self._on_home_assistant_change)
        self.alice_control = AliceControlClient(settings)
        self.avalar_ssh = AvalarSshDetailsAdapter(settings)
        self.http = HttpIntegrationAdapter(
            settings,
            details_provider=self.avalar_ssh,
        )
        self.rog_g703 = RogG703Device(settings)
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
        self._snapshot_callback = callback
        self.http.set_on_change(callback)
        self.planning.set_on_change(callback)
        self.rog_g703.set_on_change(callback)

    def set_coffee_schedule_callback(
        self,
        callback: Callable[[], Awaitable[None]] | None,
    ) -> None:
        self._coffee_schedule_callback = callback

    async def _on_home_assistant_change(self) -> None:
        if self._snapshot_callback is not None:
            await self._snapshot_callback()
        if self._coffee_schedule_callback is not None:
            await self._coffee_schedule_callback()

    async def start(self) -> None:
        await self.home_assistant.start()
        await self.avalar_ssh.start()
        await self.http.start()
        await self.planning.start()
        await self.rog_g703.start()

    async def start_planning(self) -> None:
        """Start only the feature-gated Planning adapter in fixture modes."""

        await self.planning.start()

    async def close(self) -> None:
        await self.http.close()
        await self.avalar_ssh.close()
        await self.home_assistant.close()
        await self.planning.close()
        await self.rog_g703.close()

    def services(self) -> List[ServiceSnapshot]:
        services = (
            self.home_assistant.services()
            + self.http.services()
            + ([self.rog_g703.service_snapshot()] if self.rog_g703.enabled else [])
        )
        return sorted(
            services,
            key=lambda service: service.presentation.priority
            if service.presentation
            else 0,
            reverse=True,
        )

    def planning_snapshot(self) -> PlanningProjection | None:
        return self.planning.projection
