from __future__ import annotations

from typing import List

from .contracts import ServiceSnapshot
from .home_assistant import HomeAssistantAdapter
from .http_integrations import HttpIntegrationAdapter
from .settings import IntegrationSettings
from .ssh_details import AvalarSshDetailsAdapter


class IntegrationRuntime:
    def __init__(self, settings: IntegrationSettings) -> None:
        self.settings = settings
        self.home_assistant = HomeAssistantAdapter(settings)
        self.avalar_ssh = AvalarSshDetailsAdapter(settings)
        self.http = HttpIntegrationAdapter(
            settings,
            details_provider=self.avalar_ssh,
        )

    async def start(self) -> None:
        await self.home_assistant.start()
        await self.avalar_ssh.start()
        await self.http.start()

    async def close(self) -> None:
        await self.http.close()
        await self.avalar_ssh.close()
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
