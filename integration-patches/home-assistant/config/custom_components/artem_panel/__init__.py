"""Home Assistant service for the Samsung panel's fixed brightness bridge."""

from __future__ import annotations

import voluptuous as vol
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError

from .request_gateway import (
    COMMAND_EVENT, STATE_ENTITY, STATE_EVENT, BrightnessGateway,
    BrightnessRequestError, validate_percent,
)

DOMAIN = "artem_panel"
CONFIG_SCHEMA = vol.Schema({DOMAIN: vol.Schema({})}, extra=vol.ALLOW_EXTRA)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    if DOMAIN in hass.data:
        return True

    @callback
    def current_state():
        entity = hass.states.get(STATE_ENTITY)
        if entity is None or entity.state in {"unknown", "unavailable"}:
            return None
        return dict(entity.attributes)

    @callback
    def subscribe(receive):
        @callback
        def on_state(event):
            receive(dict(event.data))
        return hass.bus.async_listen(STATE_EVENT, on_state)

    gateway = BrightnessGateway(
        state=current_state,
        subscribe=subscribe,
        fire=lambda data: hass.bus.async_fire(COMMAND_EVENT, data),
    )

    async def set_brightness(call: ServiceCall) -> None:
        try:
            await gateway.set_brightness(call.data["percent"])
        except BrightnessRequestError as exc:
            messages = {
                "busy": "Управление яркостью панели уже выполняется.",
                "unavailable": "Управление яркостью панели сейчас недоступно.",
                "unconfirmed": "Фактическая яркость панели не подтверждена. Команда не повторялась.",
            }
            raise HomeAssistantError(messages.get(str(exc), messages["unconfirmed"])) from exc

    hass.services.async_register(
        DOMAIN, "set_brightness", set_brightness,
        schema=vol.Schema({vol.Required("percent"): validate_percent}, extra=vol.PREVENT_EXTRA),
    )
    hass.data[DOMAIN] = gateway

    @callback
    def stop(_):
        gateway.close()
        hass.services.async_remove(DOMAIN, "set_brightness")
        hass.data.pop(DOMAIN, None)

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, stop)
    return True
