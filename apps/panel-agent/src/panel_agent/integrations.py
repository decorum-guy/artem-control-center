from __future__ import annotations

from typing import List

from .contracts import ServiceSnapshot
from .home_assistant import HomeAssistantAdapter
from .http_integrations import HttpIntegrationAdapter
from .settings import IntegrationSettings


class IntegrationRuntime:
    def __init__(self, settings: IntegrationSettings) -> None:
        self.settings = settings
        self.home_assistant = HomeAssistantAdapter(settings)
        self.http = HttpIntegrationAdapter(settings)

    async def start(self) -> None:
        await self.home_assistant.start()
        await self.http.refresh()

    async def close(self) -> None:
        await self.home_assistant.close()

    def services(self) -> List[ServiceSnapshot]:
        services = self.home_assistant.services() + self.http.services()
        return sorted(
            services,
            key=lambda service: service.presentation.priority
            if service.presentation
            else 0,
            reverse=True,
        )
