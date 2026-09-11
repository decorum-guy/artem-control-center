from __future__ import annotations

import asyncio
from typing import Awaitable, Callable, List

import httpx

from .contracts import PanelMode, ServiceSnapshot
from .alice_control import AliceControlClient
from .home_assistant import HomeAssistantAdapter
from .http_integrations import HttpIntegrationAdapter
from .project_monitor import DeclarativeProjectMonitor
from .project_registry import ProjectRegistry, load_project_registry
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
        project_registry: ProjectRegistry | None = None,
        project_monitor_transport: httpx.AsyncBaseTransport | None = None,
        project_action_availability_provider: Callable[[str], bool] | None = None,
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
        self.project_registry = (
            project_registry
            if project_registry is not None
            else load_project_registry(settings.projects_config_path)
        )
        self._project_monitor_transport = project_monitor_transport
        self._project_action_availability_provider = project_action_availability_provider
        self.project_monitor = DeclarativeProjectMonitor(
            self.project_registry,
            settings,
            transport=project_monitor_transport,
            details_provider=self.avalar_ssh,
            action_availability_provider=project_action_availability_provider,
        )
        self._runtime_started = False
        self._project_registry_swap_lock: asyncio.Lock | None = None
        self._project_registry_swap_loop: asyncio.AbstractEventLoop | None = None
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
        self.project_monitor.set_on_change(callback)
        self.planning.set_on_change(callback)
        self.rog_g703.set_on_change(callback)

    def set_coffee_schedule_callback(
        self,
        callback: Callable[[], Awaitable[None]] | None,
    ) -> None:
        self._coffee_schedule_callback = callback

    def set_project_action_availability_provider(
        self,
        provider: Callable[[str], bool] | None,
    ) -> None:
        self._project_action_availability_provider = provider
        self.project_monitor.set_action_availability_provider(provider)

    async def _on_home_assistant_change(self) -> None:
        if self._snapshot_callback is not None:
            await self._snapshot_callback()
        if self._coffee_schedule_callback is not None:
            await self._coffee_schedule_callback()

    async def replace_project_registry(self, registry: ProjectRegistry) -> None:
        """Swap the declarative monitor without restarting other adapters."""

        loop = asyncio.get_running_loop()
        if (
            self._project_registry_swap_lock is None
            or self._project_registry_swap_loop is not loop
        ):
            self._project_registry_swap_lock = asyncio.Lock()
            self._project_registry_swap_loop = loop

        async with self._project_registry_swap_lock:
            previous_monitor = self.project_monitor
            should_start = self._runtime_started or previous_monitor.running
            replacement = DeclarativeProjectMonitor(
                registry,
                self.settings,
                transport=self._project_monitor_transport,
                details_provider=self.avalar_ssh,
                action_availability_provider=self._project_action_availability_provider,
            )

            # Stop the old task before starting the replacement.  This keeps
            # one authoritative monitor collection and prevents duplicate
            # polling during a revision swap.
            await previous_monitor.close()
            self.project_registry = registry
            self.project_monitor = replacement
            try:
                if should_start:
                    await replacement.start()
            finally:
                # Start without the callback so an initial health probe cannot
                # race the route's explicit snapshot rebuild.  The callback
                # is then attached to the live replacement for all future
                # refreshes.
                replacement.set_on_change(self._snapshot_callback)

    async def start(self) -> None:
        await self.home_assistant.start()
        await self.avalar_ssh.start()
        await self.http.start()
        await self.project_monitor.start()
        await self.planning.start()
        await self.rog_g703.start()
        self._runtime_started = True

    async def start_planning(self) -> None:
        """Start only the feature-gated Planning adapter in fixture modes."""

        await self.planning.start()

    async def close(self) -> None:
        self._runtime_started = False
        await self.project_monitor.close()
        await self.http.close()
        await self.avalar_ssh.close()
        await self.home_assistant.close()
        await self.planning.close()
        await self.rog_g703.close()

    def services(self) -> List[ServiceSnapshot]:
        services = (
            self.home_assistant.services()
            + self.http.services()
            + self.project_monitor.services()
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
