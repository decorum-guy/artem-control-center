import importlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def load_app(monkeypatch, path: Path, *, writes: bool = True):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true" if writes else "false")
    monkeypatch.setenv("PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED", "true" if writes else "false")
    monkeypatch.setenv("PANEL_OVERVIEW_LAYOUT_PATH", str(path))
    import panel_agent.main

    return importlib.reload(panel_agent.main)


def get_layout(client: TestClient):
    response = client.get("/api/v1/overview/layout")
    assert response.status_code == 200
    return response


def test_trusted_appearance_schema_matches_registered_widget_vocabulary(tmp_path, monkeypatch):
    load_app(monkeypatch, tmp_path / "layout.json", writes=False)
    from panel_agent import overview_layout

    schema_widgets = overview_layout.APPEARANCE_SCHEMA["widgets"]
    assert set(schema_widgets) == set(overview_layout.WIDGETS)
    for widget_type, descriptor in schema_widgets.items():
        controls = descriptor["controls"]
        control_keys = {control["key"] for control in controls}
        assert set(descriptor["defaults"]) == control_keys
        assert all(control["control"] in {"boolean", "enum", "integer_range"} for control in controls)


def test_get_without_file_returns_shipped_v2_and_no_store(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=False)
    with TestClient(module.app) as client:
        response = get_layout(client)
        payload = response.json()
        assert payload["schemaVersion"] == "overview.layout.v2"
        assert payload["presetId"] == "overview.default"
        assert payload["presetVersion"] == 2
        assert payload["revision"] == 0
        assert payload["writesEnabled"] is False
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["etag"] == '"0"'


def test_write_requires_both_write_flags_and_exact_if_match(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=False)
    with TestClient(module.app) as client:
        payload = get_layout(client).json()
        assert client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": '"0"'},
            json={"items": payload["items"]},
        ).status_code == 403

    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True)
    with TestClient(module.app) as client:
        payload = get_layout(client).json()
        missing = client.patch(
            "/api/v1/overview/layout",
            json={"items": payload["items"]},
        )
        assert missing.status_code == 428
        conflict = client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": '"9"'},
            json={"items": payload["items"]},
        )
        assert conflict.status_code == 412
        assert conflict.json()["detail"] == "revision_conflict"


def test_valid_appearance_patch_is_atomic_revisioned_and_survives_restart(tmp_path, monkeypatch):
    path = tmp_path / "nested" / "overview-layout.json"
    module = load_app(monkeypatch, path, writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        candidate = initial.json()["items"]
        coffee = next(item for item in candidate if item["widgetType"] == "home.coffee-machine")
        coffee["config"]["imageScalePct"] = 120
        saved = client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json={"items": candidate},
        )
        assert saved.status_code == 200
        assert saved.json()["revision"] == 1
        assert saved.headers["etag"] == '"1"'
        assert saved.headers["cache-control"] == "no-store"
        assert saved.json()["items"][1]["config"]["imageScalePct"] == 120

    assert path.read_bytes()[:3] != b"\xef\xbb\xbf"
    serialized = path.read_bytes().decode("utf-8")
    assert serialized
    for forbidden in ("PANEL_HA_TOKEN", "PANEL_PLANNING_SECRET", "http://", "https://", "actionId", "AA:BB:CC:DD:EE:FF"):
        assert forbidden not in serialized
    module = load_app(monkeypatch, path, writes=True)
    with TestClient(module.app) as client:
        loaded = get_layout(client).json()
        assert loaded["revision"] == 1
        assert next(item for item in loaded["items"] if item["widgetType"] == "home.coffee-machine")["config"]["imageScalePct"] == 120


def test_invalid_full_candidate_and_dangerous_config_leave_old_file_unchanged(tmp_path, monkeypatch):
    path = tmp_path / "layout.json"
    module = load_app(monkeypatch, path, writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        old_bytes = path.read_bytes() if path.exists() else b""
        items = initial.json()["items"]
        items[1]["config"]["style"] = {"transform": "translate(1px)"}
        rejected = client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json={"items": items},
        )
        assert rejected.status_code == 422
        assert not path.exists() or path.read_bytes() == old_bytes

        duplicate = initial.json()["items"] + [dict(initial.json()["items"][0])]
        duplicate[5]["instanceId"] = "duplicate.rog"
        duplicate_response = client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json={"items": duplicate},
        )
        assert duplicate_response.status_code == 422


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schemaVersion", "overview.layout.v1"),
        ("profileId", "other-profile"),
        ("revision", 99),
    ],
)
def test_patch_cannot_override_server_owned_fields(tmp_path, monkeypatch, field, value):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        body = {"items": initial.json()["items"], field: value}
        response = client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json=body,
        )
        assert response.status_code == 422


def test_patch_rejects_unknown_widget_and_oversized_item_collection(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        items = initial.json()["items"]
        unknown = dict(items[0])
        unknown["instanceId"] = "unknown.widget"
        unknown["widgetType"] = "future.remote-widget"
        assert client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json={"items": items + [unknown]},
        ).status_code == 422

        oversized = items * 7
        assert client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json={"items": oversized},
        ).status_code == 422


@pytest.mark.parametrize(
    "mutate",
    [
        lambda items: items[0].update({"visibility": "maybe"}),
        lambda items: items[0]["placement"].update({"x": -1}),
        lambda items: items[0]["placement"].update({"w": 11}),
        lambda items: items[0].update({"sizeVariant": "detail"}),
        lambda items: items[0]["config"].update({"className": "unsafe"}),
        lambda items: items[1]["config"].update({"imageScalePct": 999}),
        lambda items: items[1]["config"].update({"composition": "arbitrary"}),
        lambda items: items[1]["config"].update({"imageScalePct": "100"}),
        lambda items: items[1]["config"].update({"nested": {"html": "x"}}),
    ],
)
def test_explicit_validator_rejects_unsafe_or_malformed_values(tmp_path, monkeypatch, mutate):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        items = initial.json()["items"]
        mutate(items)
        response = client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json={"items": items},
        )
        assert response.status_code in {422, 400}


def test_legacy_migration_and_corrupt_fallback_never_overwrite_bytes(tmp_path, monkeypatch):
    path = tmp_path / "layout.json"
    legacy = {
        "version": 1,
        "revision": 4,
        "profiles": [{
            "id": "desk",
            "items": [{
                "widget_id": "widget.coffee.primary",
                "x": 0,
                "y": 2,
                "width": 7,
                "height": 4,
            }, {
                "widget_id": "future.remote-widget",
                "x": 0,
                "y": 7,
                "width": 4,
                "height": 3,
            }],
        }],
    }
    path.write_text(json.dumps(legacy), encoding="utf-8")
    legacy_bytes = path.read_bytes()
    module = load_app(monkeypatch, path, writes=False)
    with TestClient(module.app) as client:
        response = get_layout(client)
        payload = response.json()
        assert payload["revision"] == 4
        assert any(item["widgetType"] == "home.coffee-machine" for item in payload["items"])
        assert payload["unplaced"][0]["widgetType"] == "future.remote-widget"
    assert path.read_bytes() == legacy_bytes

    path.write_bytes(b"not-json")
    corrupt_bytes = path.read_bytes()
    module = load_app(monkeypatch, path, writes=False)
    with TestClient(module.app) as client:
        payload = get_layout(client).json()
        assert payload["presetVersion"] == 2
        assert payload["revision"] == 0
        assert payload["warnings"]
    assert path.read_bytes() == corrupt_bytes


def test_unknown_stored_widget_keeps_valid_items_and_is_safe_metadata(tmp_path, monkeypatch):
    path = tmp_path / "layout.json"
    module = load_app(monkeypatch, path, writes=False)
    with TestClient(module.app) as client:
        initial = get_layout(client).json()
    initial["items"].append({
        "instanceId": "unknown.instance",
        "widgetType": "plugin.remote",
        "visibility": "visible",
        "placement": {"x": 0, "y": 8, "w": 3, "h": 1},
        "sizeVariant": "compact",
        "config": {"url": "https://evil.test"},
    })
    path.write_text(json.dumps(initial, ensure_ascii=False), encoding="utf-8")
    stored_bytes = path.read_bytes()
    module = load_app(monkeypatch, path, writes=False)
    with TestClient(module.app) as client:
        payload = get_layout(client).json()
        assert len(payload["items"]) == 5
        assert payload["unplaced"] == [{"instanceId": "unknown.instance", "widgetType": "plugin.remote", "reason": "widget type is not registered"}]
    assert path.read_bytes() == stored_bytes
    serialized = path.read_text(encoding="utf-8")
    assert "PANEL_HA_TOKEN" not in serialized
    assert "companion secret" not in serialized.lower()


def test_atomic_write_failure_preserves_previous_canonical_file(tmp_path, monkeypatch):
    from panel_agent.overview_layout import OverviewLayoutStore
    from panel_agent.contracts import OverviewLayoutPatch

    path = tmp_path / "layout.json"
    store = OverviewLayoutStore(str(path), writes_enabled=True)
    first = store.read()
    patch = OverviewLayoutPatch(items=first.items)
    store.write(patch, 0)
    old_bytes = path.read_bytes()
    monkeypatch.setattr("panel_agent.overview_layout.os.replace", lambda *_args: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        store.write(patch, 1)
    assert path.read_bytes() == old_bytes
