"""Provider-neutral, text-only AI boundary for Control Center.

Adapters own fixed official transports.  Callers supply no endpoint, headers or
provider request body.  There are deliberately no tools, browser access or
mutation semantics here.
"""
from __future__ import annotations

import asyncio
import json
import ssl
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

import httpx

from .ai_settings import AIProviderSettingsStore, MODELS
from .planning import PlanningProjection
from .settings import IntegrationSettings

ProviderId = Literal["gigachat", "yandex", "deepseek", "local"]
ErrorCategory = Literal["not_configured", "disabled", "authentication_failed", "rate_limited", "timeout", "transport_error", "provider_error", "malformed_response", "configuration_error", "context_unavailable", "fallback_unavailable"]

TIER1_PHRASES = {"acknowledged": "Слушаю.", "completed": "Готово.", "command_failed": "Не удалось выполнить команду."}
FALLBACK_ERRORS = frozenset({"timeout", "transport_error", "provider_error", "rate_limited"})
MAX_GIGACHAT_CA_BUNDLE_BYTES = 4 * 1024 * 1024

@dataclass(frozen=True)
class AITextRequest:
    purpose: Literal["planning_today", "tier1"]
    instruction: str
    user_text: str
    facts: dict[str, Any]
    locale: str = "ru-RU"
    timezone: str = "Europe/Moscow"
    max_output_chars: int = 900
    tier1_key: str | None = None

@dataclass(frozen=True)
class AITextResult:
    text: str | None
    provider_id: str | None
    model_id: str | None
    status: Literal["completed", "failed"]
    error_category: ErrorCategory | None = None
    fallback_used: bool = False
    latency_ms: int | None = None
    context_warning: str | None = None
    tier1: bool = False

def project_today(planning: PlanningProjection | None, *, now: datetime, timezone: str) -> dict[str, Any]:
    """Make a small, human-facing-only projection. IDs and source internals stay out."""
    if planning is None:
        return {"calendar": {"availability": "unavailable", "items": []}, "tasks": {"availability": "unavailable", "items": []}, "reminders": {"availability": "unavailable", "items": []}}
    warning = "current" if planning.sourceStatus == "current" else planning.sourceStatus
    events = []
    for item in planning.calendar.today[:20]:
        events.append({"title": item.title, "allDay": item.allDay, "startAtUtc": item.startAtUtc, "endAtUtc": item.endAtUtc, "startDate": item.startDate, "endDateExclusive": item.endDateExclusive, "timezone": item.timezone, "location": item.location})
    tasks = [{"title": item.title, "status": item.status, "dueDate": item.dueDate, "dueTime": item.dueTime, "timezone": item.timezone, "priority": item.priority} for item in planning.tasks.today[:20]]
    reminders = [{"title": item.title, "status": item.status, "dueAtUtc": item.dueAtUtc, "timezone": item.timezone, "deliveryState": item.deliveryState} for item in planning.reminders.upcoming[:20]]
    return {"date": now.astimezone(ZoneInfo(timezone)).date().isoformat(), "calendar": {"availability": warning, "items": events}, "tasks": {"availability": warning, "items": tasks}, "reminders": {"availability": warning, "items": reminders}}

def _prompt(request: AITextRequest) -> str:
    facts = json.dumps(request.facts, ensure_ascii=False, separators=(",", ":"))
    return f"{request.instruction}\nЯзык ответа: русский. Часовой пояс: {request.timezone}.\nИспользуй только факты в JSON ниже. Не выдумывай встречи, даты, статусы или напоминания. Если раздел unavailable/stale/offline, прямо сообщи это; пустой список означает отсутствие известных элементов. Ответь кратко, без служебных деталей.\nФакты: {facts}\nЗапрос владельца: {request.user_text}"

def _error(status_code: int) -> ErrorCategory:
    if status_code in {401, 403}: return "authentication_failed"
    if status_code == 429: return "rate_limited"
    return "provider_error"

class ProviderFailure(RuntimeError):
    def __init__(self, category: ErrorCategory): self.category = category

class TextProvider:
    id: ProviderId
    def __init__(self, settings: IntegrationSettings, store: AIProviderSettingsStore, transport: httpx.AsyncBaseTransport | None = None): self.settings, self.store, self.transport = settings, store, transport
    def configured(self) -> bool:
        snapshot, _ = self.store.snapshot()
        return bool(snapshot.credentials.get(self.id))
    async def generate(self, request: AITextRequest, model: str) -> str: raise NotImplementedError
    @property
    def tls_verify(self) -> bool | ssl.SSLContext:
        return True
    async def _post(self, url: str, *, headers: dict[str, str], payload: dict[str, Any], form: dict[str, str] | None = None) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self.settings.ai_request_timeout_seconds, transport=self.transport, verify=self.tls_verify, follow_redirects=False) as client:
                response = await client.post(url, headers=headers, json=None if form else payload, data=form)
        except httpx.TimeoutException as exc: raise ProviderFailure("timeout") from exc
        except (httpx.HTTPError, OSError, ssl.SSLError) as exc: raise ProviderFailure("transport_error") from exc
        if response.status_code >= 400: raise ProviderFailure(_error(response.status_code))
        try:
            value = response.json()
            if not isinstance(value, dict): raise ValueError()
            return value
        except (ValueError, json.JSONDecodeError) as exc: raise ProviderFailure("malformed_response") from exc

class GigaChatProvider(TextProvider):
    id: ProviderId = "gigachat"
    def __init__(self, settings: IntegrationSettings, store: AIProviderSettingsStore, transport: httpx.AsyncBaseTransport | None = None):
        super().__init__(settings, store, transport)
        self._token: str | None = None
        self._expires_at: float = 0
        self._ssl_context: ssl.SSLContext | None = None

    @property
    def tls_verify(self) -> ssl.SSLContext:
        if self._ssl_context is not None:
            return self._ssl_context
        bundle_path = self.settings.ai_gigachat_ca_bundle_path.strip()
        try:
            path = Path(bundle_path)
            if not bundle_path or "\x00" in bundle_path or not path.is_file() or path.stat().st_size <= 0 or path.stat().st_size > MAX_GIGACHAT_CA_BUNDLE_BYTES:
                raise ValueError
            self._ssl_context = ssl.create_default_context(cafile=str(path))
        except (OSError, ssl.SSLError, ValueError, TypeError) as exc:
            raise ProviderFailure("configuration_error") from exc
        return self._ssl_context

    async def _token_for_request(self) -> str:
        if self._token and self._expires_at - time.time() > 30: return self._token
        snapshot, _ = self.store.snapshot(); credential = snapshot.credentials.get(self.id)
        if not credential: raise ProviderFailure("not_configured")
        result = await self._post("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", headers={"Authorization": f"Basic {credential}", "Accept": "application/json", "RqUID": str(uuid.uuid4())}, payload={}, form={"scope": "GIGACHAT_API_PERS"})
        token, expires = result.get("access_token"), result.get("expires_at")
        if not isinstance(token, str) or not token or not isinstance(expires, (int, float)): raise ProviderFailure("malformed_response")
        self._token, self._expires_at = token, float(expires)
        return token
    async def generate(self, request: AITextRequest, model: str) -> str:
        token = await self._token_for_request()
        result = await self._post("https://api.giga.chat/v1/chat/completions", headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"}, payload={"model": model, "messages": [{"role": "user", "content": _prompt(request)}], "max_tokens": 400, "stream": False})
        return _completion_text(result)

class OpenAICompatibleProvider(TextProvider):
    endpoint = ""
    async def generate(self, request: AITextRequest, model: str) -> str:
        snapshot, _ = self.store.snapshot(); credential = snapshot.credentials.get(self.id)
        if not credential: raise ProviderFailure("not_configured")
        result = await self._post(self.endpoint, headers={"Authorization": f"Bearer {credential}", "Content-Type": "application/json"}, payload={"model": model, "messages": [{"role": "system", "content": request.instruction}, {"role": "user", "content": _prompt(request)}], "max_tokens": 400, "stream": False})
        return _completion_text(result)

class DeepSeekProvider(OpenAICompatibleProvider):
    id: ProviderId = "deepseek"; endpoint = "https://api.deepseek.com/chat/completions"
    async def generate(self, request: AITextRequest, model: str) -> str:
        snapshot, _ = self.store.snapshot(); credential = snapshot.credentials.get(self.id)
        if not credential: raise ProviderFailure("not_configured")
        result = await self._post(self.endpoint, headers={"Authorization": f"Bearer {credential}", "Content-Type": "application/json"}, payload={"model": model, "messages": [{"role": "system", "content": request.instruction}, {"role": "user", "content": _prompt(request)}], "max_tokens": 400, "stream": False, "thinking": {"type": "disabled"}})
        return _completion_text(result)

class YandexProvider(TextProvider):
    id: ProviderId = "yandex"
    def configured(self) -> bool:
        return super().configured() and bool(self.settings.ai_yandex_folder_id)
    async def generate(self, request: AITextRequest, model: str) -> str:
        snapshot, _ = self.store.snapshot(); credential = snapshot.credentials.get(self.id)
        if not credential: raise ProviderFailure("not_configured")
        # The model ID is trusted registry data. A Yandex API key is the only secret.
        if not self.settings.ai_yandex_folder_id: raise ProviderFailure("not_configured")
        result = await self._post("https://ai.api.cloud.yandex.net/foundationModels/v1/completion", headers={"Authorization": f"Api-Key {credential}", "Content-Type": "application/json"}, payload={"modelUri": f"gpt://{self.settings.ai_yandex_folder_id}/{model}", "completionOptions": {"stream": False, "maxTokens": "400", "temperature": 0.2}, "messages": [{"role": "system", "text": request.instruction}, {"role": "user", "text": _prompt(request)}]})
        alternatives = result.get("result", {}).get("alternatives") if isinstance(result.get("result"), dict) else None
        if not isinstance(alternatives, list) or not alternatives or not isinstance(alternatives[0], dict) or not isinstance(alternatives[0].get("message"), dict): raise ProviderFailure("malformed_response")
        text = alternatives[0]["message"].get("text")
        return _bounded_text(text)

class LocalProvider(TextProvider):
    id: ProviderId = "local"
    def configured(self) -> bool: return self.settings.ai_local_enabled and bool(self.settings.ai_local_model)
    async def generate(self, request: AITextRequest, model: str) -> str:
        if not self.configured(): raise ProviderFailure("not_configured")
        result = await self._post(self.settings.ai_local_base_url, headers={"Content-Type": "application/json"}, payload={"model": model, "prompt": _prompt(request), "stream": False})
        return _bounded_text(result.get("response"))

def _bounded_text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip(): raise ProviderFailure("malformed_response")
    return value.strip()[:900]
def _completion_text(result: dict[str, Any]) -> str:
    choices = result.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict) or not isinstance(choices[0].get("message"), dict): raise ProviderFailure("malformed_response")
    return _bounded_text(choices[0]["message"].get("content"))

class AITextService:
    def __init__(self, settings: IntegrationSettings, store: AIProviderSettingsStore, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.settings, self.store = settings, store
        self.providers: dict[str, TextProvider] = {"gigachat": GigaChatProvider(settings, store, transport), "yandex": YandexProvider(settings, store, transport), "deepseek": DeepSeekProvider(settings, store, transport), "local": LocalProvider(settings, store, transport)}
        # Constructed during application import, before an event loop exists on
        # Python 3.9 as well as on the supported runtime.
        self._lock: asyncio.Lock | None = None
    async def generate(self, request: AITextRequest) -> AITextResult:
        if request.tier1_key:
            phrase = TIER1_PHRASES.get(request.tier1_key)
            if phrase: return AITextResult(phrase, None, None, "completed", tier1=True)
        if not self.settings.ai_text_enabled: return AITextResult(None, None, None, "failed", "disabled")
        if request.purpose == "planning_today" and request.facts.get("calendar", {}).get("availability") == "unavailable" and request.facts.get("tasks", {}).get("availability") == "unavailable": return AITextResult(None, None, None, "failed", "context_unavailable")
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            snapshot, available = self.store.snapshot()
            if not available: return AITextResult(None, None, None, "failed", "not_configured")
            selected = snapshot.selected_provider; model = self.settings.ai_local_model if selected == "local" else snapshot.selected_models[selected]
            result = await self._call(selected, model, request)
            if result.error_category in FALLBACK_ERRORS and selected != "local":
                fallback_model = self.settings.ai_local_model
                fallback = await self._call("local", fallback_model, request, fallback=True)
                if fallback.status == "completed": return fallback
                return AITextResult(None, selected, model, "failed", "fallback_unavailable")
            return result
    async def _call(self, provider_id: str, model: str, request: AITextRequest, fallback: bool = False) -> AITextResult:
        provider = self.providers[provider_id]
        if not provider.configured(): return AITextResult(None, provider_id, model, "failed", "not_configured", fallback)
        started = time.monotonic()
        try:
            text = await provider.generate(request, model)
            return AITextResult(text, provider_id, model, "completed", fallback_used=fallback, latency_ms=round((time.monotonic() - started) * 1000), context_warning=_context_warning(request))
        except ProviderFailure as exc:
            return AITextResult(None, provider_id, model, "failed", exc.category, fallback, round((time.monotonic() - started) * 1000))

def _context_warning(request: AITextRequest) -> str | None:
    states = [value.get("availability") for value in request.facts.values() if isinstance(value, dict)]
    return "planning_not_current" if any(value not in {None, "current"} for value in states) else None
