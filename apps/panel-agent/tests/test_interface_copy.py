from __future__ import annotations

import importlib
import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from panel_agent.contracts import InterfaceCopyPatch
from panel_agent.interface_copy import MAX_FILE_BYTES, InterfaceCopyRevisionConflict, InterfaceCopySettingsStore


def test_default_document_and_effective_copy_are_shared_and_typed(tmp_path):
    response = InterfaceCopySettingsStore(tmp_path / "copy.json", writes_enabled=True).read()
    assert response.schemaVersion == "interface.copy-settings.v1"
    assert response.revision == 0
    assert response.available is True
    assert response.overrides.navigation.overview is None
    assert response.defaults.navigation.overview == "Обзор"
    assert response.effective.page.overview.subtitle == "Сегодня, всё важное в первом экране"


def test_store_writes_navigation_title_and_empty_optional_subtitle(tmp_path):
    store = InterfaceCopySettingsStore(tmp_path / "copy.json", writes_enabled=True)
    navigation = store.write(InterfaceCopyPatch(expectedRevision=0, field="navigation.overview", value="Главная"))
    assert navigation.revision == 1
    assert navigation.effective.navigation.overview == "Главная"
    title = store.write(InterfaceCopyPatch(expectedRevision=1, field="page.overview.title", value="Мой день"))
    assert title.effective.page.overview.title == "Мой день"
    subtitle = store.write(InterfaceCopyPatch(expectedRevision=2, field="page.overview.subtitle", value=""))
    assert subtitle.overrides.page.overview.subtitle == ""
    assert subtitle.effective.page.overview.subtitle == ""


def test_validation_rejects_blank_required_overlong_markup_and_controls(tmp_path):
    store = InterfaceCopySettingsStore(tmp_path / "copy.json", writes_enabled=True)
    with pytest.raises(ValueError, match="copy_value_blank"):
        store.write(InterfaceCopyPatch(expectedRevision=0, field="navigation.overview", value="   "))
    with pytest.raises(ValueError, match="copy_value_too_long"):
        store.write(InterfaceCopyPatch(expectedRevision=0, field="navigation.overview", value="x" * 49))
    with pytest.raises(ValueError, match="copy_value_markup_not_allowed"):
        store.write(InterfaceCopyPatch(expectedRevision=0, field="page.overview.title", value="<script>"))
    with pytest.raises(ValueError, match="copy_value_control_character"):
        store.write(InterfaceCopyPatch(expectedRevision=0, field="page.overview.subtitle", value="a\nb"))


def test_patch_contract_rejects_unsupported_keys_and_invalid_shape():
    with pytest.raises(ValidationError):
        InterfaceCopyPatch.model_validate({"expectedRevision": 0, "field": "route./overview", "value": "x"})
    with pytest.raises(ValidationError):
        InterfaceCopyPatch.model_validate({"expectedRevision": 0, "field": "navigation.overview"})
    with pytest.raises(ValidationError):
        InterfaceCopyPatch.model_validate({"expectedRevision": 0, "resetAll": True, "field": "navigation.overview"})


def test_revision_conflict_reset_one_and_reset_all_are_isolated(tmp_path):
    path = tmp_path / "copy.json"
    store = InterfaceCopySettingsStore(path, writes_enabled=True)
    store.write(InterfaceCopyPatch(expectedRevision=0, field="navigation.overview", value="Главная"))
    store.write(InterfaceCopyPatch(expectedRevision=1, field="page.overview.title", value="Мой день"))
    with pytest.raises(InterfaceCopyRevisionConflict):
        store.write(InterfaceCopyPatch(expectedRevision=0, field="navigation.calendar", value="Расписание"))
    reset = store.write(InterfaceCopyPatch(expectedRevision=2, field="navigation.overview", value=None))
    assert reset.effective.navigation.overview == "Обзор"
    assert reset.effective.page.overview.title == "Мой день"
    unrelated = tmp_path / "unrelated.json"
    unrelated.write_text("keep", encoding="utf-8")
    restored = store.write(InterfaceCopyPatch(expectedRevision=3, resetAll=True))
    assert restored.revision == 4
    assert restored.overrides.navigation.overview is None
    assert restored.effective.page.overview.title == "Обзор"
    assert unrelated.read_text(encoding="utf-8") == "keep"
    assert not list(tmp_path.glob("*.tmp"))


@pytest.mark.parametrize(
    ("document", "write_bytes"),
    [
        ("{not-json", False),
        (json.dumps({"schemaVersion": "interface.copy-settings.v0"}), False),
        (None, True),
    ],
    ids=["malformed-json", "unsupported-schema", "oversized"],
)
def test_invalid_documents_fail_closed_and_recover_only_through_global_reset(tmp_path, document, write_bytes):
    path = tmp_path / "copy.json"
    store = InterfaceCopySettingsStore(path, writes_enabled=True)
    store.write(InterfaceCopyPatch(expectedRevision=0, field="navigation.calendar", value="Расписание"))
    reloaded = InterfaceCopySettingsStore(path, writes_enabled=True).read()
    assert reloaded.revision == 1
    assert reloaded.effective.navigation.calendar == "Расписание"
    if write_bytes:
        path.write_bytes(b"x" * (MAX_FILE_BYTES + 1))
    else:
        path.write_text(document, encoding="utf-8")
    malformed = InterfaceCopySettingsStore(path, writes_enabled=True).read()
    assert malformed.available is False
    assert malformed.warnings == ["stored_copy_settings_unavailable"]
    assert malformed.revision == 0
    assert malformed.recoveryRevision == 0
    assert malformed.effective.navigation.calendar == "Календарь"
    with pytest.raises(ValueError, match="stored_copy_settings_unavailable"):
        store.write(InterfaceCopyPatch(expectedRevision=0, field="navigation.calendar", value="Расписание"))

    unrelated = tmp_path / "unrelated.json"
    unrelated.write_text("keep", encoding="utf-8")
    recovered = store.write(InterfaceCopyPatch(expectedRevision=0, resetAll=True))
    assert recovered.available is True
    assert recovered.recoveryRevision is None
    assert recovered.revision == 1
    assert recovered.overrides.navigation.calendar is None
    assert recovered.effective.navigation.calendar == "Календарь"
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert set(on_disk) == {"schemaVersion", "revision", "updatedAt", "overrides"}
    assert on_disk["schemaVersion"] == "interface.copy-settings.v1"
    assert on_disk["revision"] == 1
    assert on_disk["overrides"] == {
        "navigation": {},
        "navigationGroup": {},
        "page": {
            "overview": {}, "weather": {}, "home": {}, "services": {},
            "calendar": {}, "tasks": {}, "reminders": {}, "backups": {},
            "apps": {}, "system": {}, "settings": {}
        },
    }
    post_recovery = store.write(InterfaceCopyPatch(expectedRevision=1, field="navigation.calendar", value="Расписание"))
    assert post_recovery.effective.navigation.calendar == "Расписание"
    assert unrelated.read_text(encoding="utf-8") == "keep"
    assert not list(tmp_path.glob("*.tmp"))


def test_invalid_store_recovery_has_deterministic_revision_and_no_delete_or_path_surface(tmp_path):
    path = tmp_path / "copy.json"
    path.write_text("not-json", encoding="utf-8")
    store = InterfaceCopySettingsStore(path, writes_enabled=True)
    assert store.read().recoveryRevision == 0
    with pytest.raises(ValidationError):
        InterfaceCopyPatch.model_validate({"expectedRevision": 0, "resetAll": True, "path": "/tmp/other.json"})
    assert path.exists()
    import panel_agent.main as main_module

    assert not any(route.path == "/api/v1/settings/interface-copy/{path}" for route in main_module.app.routes)


def test_fixture_copy_scenarios_and_endpoint_round_trip(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_INTERFACE_COPY_PATH", str(tmp_path / "copy.json"))
    import panel_agent.main

    module = importlib.reload(panel_agent.main)
    with TestClient(module.app) as client:
        fixtures = client.get("/api/v1/fixtures")
        assert "custom-navigation" in fixtures.json()["interfaceCopyScenarios"]
        fixture = client.get("/api/v1/settings/interface-copy?fixtureScenario=custom-navigation")
        assert fixture.status_code == 200
        assert fixture.json()["effective"]["navigation"]["overview"] == "Главная"
        current = client.get("/api/v1/settings/interface-copy").json()
        saved = client.patch("/api/v1/settings/interface-copy", json={
            "expectedRevision": current["revision"],
            "field": "navigation.overview",
            "value": "Главная",
        })
        assert saved.status_code == 200
        conflict = client.patch("/api/v1/settings/interface-copy", json={
            "expectedRevision": current["revision"],
            "field": "navigation.calendar",
            "value": "Расписание",
        })
        assert conflict.status_code == 409

        module.interface_copy_store.path.write_text("{not-json", encoding="utf-8")
        invalid = client.get("/api/v1/settings/interface-copy")
        assert invalid.status_code == 200
        assert invalid.json()["available"] is False
        assert invalid.json()["recoveryRevision"] == 0
        blocked = client.patch("/api/v1/settings/interface-copy", json={
            "expectedRevision": 0,
            "field": "navigation.overview",
            "value": "Главная",
        })
        assert blocked.status_code == 503
        recovered = client.patch("/api/v1/settings/interface-copy", json={
            "expectedRevision": invalid.json()["recoveryRevision"],
            "resetAll": True,
        })
        assert recovered.status_code == 200
        assert recovered.json()["available"] is True
        assert recovered.json()["recoveryRevision"] is None
        assert recovered.json()["overrides"]["navigation"]["overview"] is None
        assert recovered.json()["effective"]["navigation"]["overview"] == "Обзор"
        post_recovery = client.patch("/api/v1/settings/interface-copy", json={
            "expectedRevision": recovered.json()["revision"],
            "field": "navigation.overview",
            "value": "Главная",
        })
        assert post_recovery.status_code == 200
        assert post_recovery.json()["effective"]["navigation"]["overview"] == "Главная"
        assert client.delete("/api/v1/settings/interface-copy").status_code == 405
