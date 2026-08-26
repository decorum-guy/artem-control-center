from __future__ import annotations

import asyncio
import json
import ssl
from datetime import datetime, timezone

import httpx

from panel_agent.ai_settings import AIProviderSettingsStore
from panel_agent.ai_text import AITextRequest, AITextService, project_today
from panel_agent.planning_adapter import PlanningAdapter
from panel_agent.planning_fixtures import PlanningFixtureTransport
from panel_agent.settings import IntegrationSettings


def settings(tmp_path, **overrides):
    return IntegrationSettings(ai_text_enabled=True, ai_settings_path=str(tmp_path / "ai.json"), **overrides)


def request():
    return AITextRequest(purpose="planning_today", instruction="Только факты.", user_text="Что у меня сегодня?", facts={"calendar": {"availability": "current", "items": []}, "tasks": {"availability": "current", "items": []}, "reminders": {"availability": "current", "items": []}})


def test_store_never_returns_plaintext_and_keeps_other_credentials(tmp_path):
    store = AIProviderSettingsStore(str(tmp_path / "ai.json"))
    store.credential(expected_revision=0, provider_id="gigachat", value="giga-secret-canary")
    store.credential(expected_revision=1, provider_id="deepseek", value="deepseek-secret-canary")
    store.select(expected_revision=2, provider_id="deepseek", model="deepseek-v4-flash")
    public = store.public(enabled=True, writes_enabled=True, local_enabled=False, local_model="local-text")
    assert "canary" not in str(public)
    assert public["selectedProvider"] == "deepseek"
    assert next(item for item in public["providers"] if item["id"] == "gigachat")["credentialPresent"] is True
    store.credential(expected_revision=3, provider_id="deepseek", value=None)
    assert store.snapshot()[0].credentials == {"gigachat": "giga-secret-canary"}


def test_gigachat_exchanges_and_caches_token_then_normalizes_response(tmp_path, monkeypatch):
    calls = []
    def handler(req: httpx.Request):
        calls.append(req)
        if req.url.path.endswith("/oauth"):
            assert req.headers["Authorization"] == "Basic giga-secret-canary"
            return httpx.Response(200, json={"access_token": "transient-token", "expires_at": 4_102_444_800})
        assert req.url == httpx.URL("https://api.giga.chat/v1/chat/completions")
        assert "giga-secret-canary" not in req.content.decode()
        return httpx.Response(200, json={"choices": [{"message": {"content": "Сегодня свободно."}}]})
    store = AIProviderSettingsStore(str(tmp_path / "ai.json")); store.credential(expected_revision=0, provider_id="gigachat", value="giga-secret-canary")
    bundle = tmp_path / "russian-trusted-root.pem"; bundle.write_text("configured-ca", encoding="utf-8")
    monkeypatch.setattr("panel_agent.ai_text.ssl.create_default_context", lambda cafile: object())
    service = AITextService(settings(tmp_path, ai_gigachat_ca_bundle_path=str(bundle)), store, transport=httpx.MockTransport(handler))
    first = asyncio.run(service.generate(request())); second = asyncio.run(service.generate(request()))
    assert first.text == "Сегодня свободно." and second.status == "completed"
    assert len(calls) == 3


def test_tier1_bypasses_transport_and_cloud_failure_uses_local_fallback(tmp_path, monkeypatch):
    calls = []
    def handler(req: httpx.Request):
        calls.append(str(req.url))
        if req.url.host == "ngw.devices.sberbank.ru": return httpx.Response(503)
        return httpx.Response(200, json={"response": "Локальный ответ."})
    store = AIProviderSettingsStore(str(tmp_path / "ai.json")); store.credential(expected_revision=0, provider_id="gigachat", value="key")
    bundle = tmp_path / "russian-trusted-root.pem"; bundle.write_text("configured-ca", encoding="utf-8")
    monkeypatch.setattr("panel_agent.ai_text.ssl.create_default_context", lambda cafile: object())
    service = AITextService(settings(tmp_path, ai_local_enabled=True, ai_local_model="fixture-local-model", ai_gigachat_ca_bundle_path=str(bundle)), store, transport=httpx.MockTransport(handler))
    tier1 = asyncio.run(service.generate(AITextRequest(purpose="tier1", instruction="", user_text="", facts={}, tier1_key="acknowledged")))
    result = asyncio.run(service.generate(request()))
    assert tier1.tier1 is True and calls == ["https://ngw.devices.sberbank.ru:9443/api/v2/oauth", "http://127.0.0.1:11434/api/generate"]
    assert result.provider_id == "local" and result.model_id == "fixture-local-model" and result.fallback_used is True and result.text == "Локальный ответ."


def test_projection_uses_only_human_facts_and_preserves_unavailable(tmp_path):
    planning_settings = IntegrationSettings(panel_planning_enabled=True, panel_planning_base_url="http://fixture.test", panel_planning_internal_secret="internal-canary", panel_planning_secret="secret-canary", panel_planning_cache_path=str(tmp_path / "planning.json"), panel_planning_timezone="Europe/Moscow")
    adapter = PlanningAdapter(planning_settings, transport=PlanningFixtureTransport("overview-timed-event"), wall_clock=lambda: datetime(2026, 8, 12, tzinfo=timezone.utc))
    async def load():
        await adapter.start(); value = adapter.projection; await adapter.close(); return value
    facts = project_today(asyncio.run(load()), now=datetime(2026, 8, 12, tzinfo=timezone.utc), timezone="Europe/Moscow")
    serialized = str(facts)
    assert "id" not in serialized.lower() and "secret-canary" not in serialized and "internal-canary" not in serialized
    assert facts["calendar"]["items"][0]["title"]
    unavailable = project_today(None, now=datetime.now(timezone.utc), timezone="Europe/Moscow")
    assert unavailable["calendar"]["availability"] == "unavailable"


def test_yandex_and_deepseek_translate_through_fixed_adapters(tmp_path):
    seen = []
    def handler(req: httpx.Request):
        seen.append((str(req.url), req.headers.get("Authorization"), req.content.decode()))
        if "yandex" in req.url.host:
            return httpx.Response(200, json={"result": {"alternatives": [{"message": {"text": "Ответ Яндекса."}}]}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "Ответ DeepSeek."}}]})
    store = AIProviderSettingsStore(str(tmp_path / "ai.json"))
    store.credential(expected_revision=0, provider_id="yandex", value="yandex-canary")
    store.credential(expected_revision=1, provider_id="deepseek", value="deepseek-canary")
    store.select(expected_revision=2, provider_id="yandex", model="yandexgpt/latest")
    yandex = AITextService(settings(tmp_path, ai_yandex_folder_id="folder-123"), store, transport=httpx.MockTransport(handler))
    assert asyncio.run(yandex.generate(request())).text == "Ответ Яндекса."
    store.select(expected_revision=3, provider_id="deepseek", model="deepseek-v4-pro")
    deepseek = AITextService(settings(tmp_path), store, transport=httpx.MockTransport(handler))
    assert asyncio.run(deepseek.generate(request())).text == "Ответ DeepSeek."
    assert seen[0][0] == "https://ai.api.cloud.yandex.net/foundationModels/v1/completion"
    assert 'gpt://folder-123/yandexgpt/latest' in seen[0][2]
    assert seen[1][0] == "https://api.deepseek.com/chat/completions"
    deepseek_payload = json.loads(seen[1][2])
    assert deepseek_payload["model"] == "deepseek-v4-pro"
    assert deepseek_payload["thinking"] == {"type": "disabled"}
    assert "tools" not in deepseek_payload


def test_malformed_provider_response_is_sanitized(tmp_path):
    store = AIProviderSettingsStore(str(tmp_path / "ai.json")); store.credential(expected_revision=0, provider_id="deepseek", value="canary")
    store.select(expected_revision=1, provider_id="deepseek", model="deepseek-v4-flash")
    service = AITextService(settings(tmp_path), store, transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"raw": "provider-only-detail"})))
    result = asyncio.run(service.generate(request()))
    assert result.status == "failed" and result.error_category == "malformed_response"
    assert "provider-only-detail" not in str(result)


def test_local_model_is_server_owned_and_result_reports_the_configured_model(tmp_path):
    seen = []

    def handler(req: httpx.Request):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"response": "Локальный ответ."})

    store = AIProviderSettingsStore(str(tmp_path / "ai.json"))
    store.select(expected_revision=0, provider_id="local")
    service = AITextService(settings(tmp_path, ai_local_enabled=True, ai_local_model="fixture-local-model"), store, transport=httpx.MockTransport(handler))
    result = asyncio.run(service.generate(request()))

    assert seen[0]["model"] == "fixture-local-model"
    assert result.provider_id == "local"
    assert result.model_id == "fixture-local-model"


def test_gigachat_ca_bundle_is_used_and_invalid_trust_fails_without_details(tmp_path, monkeypatch):
    captured = []
    client_options = []

    class FakeContext:
        pass

    def fake_context(*, cafile):
        captured.append(cafile)
        return FakeContext()

    class FakeClient:
        def __init__(self, **kwargs):
            client_options.append(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr("panel_agent.ai_text.ssl.create_default_context", fake_context)
    monkeypatch.setattr("panel_agent.ai_text.httpx.AsyncClient", FakeClient)
    bundle = tmp_path / "russian-trusted-root.pem"
    bundle.write_text("configured-ca", encoding="utf-8")
    store = AIProviderSettingsStore(str(tmp_path / "ai.json"))
    store.credential(expected_revision=0, provider_id="gigachat", value="giga-canary")
    service = AITextService(settings(tmp_path, ai_gigachat_ca_bundle_path=str(bundle)), store, transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"access_token": "token", "expires_at": 4_102_444_800})))
    assert service.providers["gigachat"].tls_verify is not None
    assert captured == [str(bundle)]
    asyncio.run(service.providers["gigachat"]._post("https://api.giga.chat/v1/chat/completions", headers={}, payload={}))
    assert client_options[0]["verify"] is service.providers["gigachat"].tls_verify

    invalid = AITextService(settings(tmp_path, ai_gigachat_ca_bundle_path=str(tmp_path / "missing.pem")), store, transport=httpx.MockTransport(lambda _: httpx.Response(200, json={})))
    result = asyncio.run(invalid.generate(request()))
    assert result.status == "failed" and result.error_category == "configuration_error"
    assert str(tmp_path / "missing.pem") not in str(result)
    assert "giga-canary" not in str(result)
