from __future__ import annotations

import importlib
import asyncio
import json
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def raw_patch(app, body: bytes, headers: dict[str, str], chunks: list[bytes] | None = None):
    request_chunks = chunks or [body]

    async def run_request():
        messages = []
        index = 0

        async def receive():
            nonlocal index
            if index >= len(request_chunks):
                return {"type": "http.disconnect"}
            chunk = request_chunks[index]
            index += 1
            return {"type": "http.request", "body": chunk, "more_body": index < len(request_chunks)}

        async def send(message):
            messages.append(message)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.0"},
            "http_version": "1.1",
            "method": "PATCH",
            "scheme": "http",
            "path": "/api/v1/overview/layout",
            "raw_path": b"/api/v1/overview/layout",
            "query_string": b"",
            "headers": [(key.lower().encode("ascii"), value.encode("latin-1")) for key, value in headers.items()],
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
        }
        await app(scope, receive, send)
        start = next(message for message in messages if message["type"] == "http.response.start")
        response_body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
        response_headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in start["headers"]}
        return start["status"], response_headers, response_body

    return asyncio.run(run_request())


def load_app(monkeypatch, path: Path, *, writes: bool = True, master_writes: bool | None = None):
    monkeypatch.setenv("PANEL_AGENT_MODE", "fixtures")
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true" if (writes if master_writes is None else master_writes) else "false")
    monkeypatch.setenv("PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED", "true" if writes else "false")
    monkeypatch.setenv("PANEL_OVERVIEW_LAYOUT_PATH", str(path))
    monkeypatch.setenv("PANEL_CAPABILITY_OVERRIDES_PATH", str(path.parent / "capability-overrides.json"))
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


def test_home_climate_registry_shipped_v3_and_strict_size_singleton_validation(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True)
    from panel_agent import overview_layout

    assert overview_layout.WIDGETS["home.climate"]["sizes"] == {
        "compact": (4, 5),
        "standard": (7, 4),
        "large": (8, 5),
    }
    assert overview_layout.shipped_layout()["presetVersion"] == 3
    with TestClient(module.app) as client:
        initial = get_layout(client)
        payload = initial.json()
        climate = [item for item in payload["items"] if item["widgetType"] == "home.climate"]
        assert len(climate) == 1
        assert not any(item["widgetType"] == "home.quick-actions" for item in payload["items"])

        invalid_size = deepcopy(payload["items"])
        invalid_size[3]["sizeVariant"] = "compact"
        invalid_size[3]["placement"] = {"x": 0, "y": 5, "w": 7, "h": 4}
        assert client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json={"items": invalid_size},
        ).status_code == 422

        duplicate = deepcopy(payload["items"])
        duplicate.append(deepcopy(next(item for item in duplicate if item["widgetType"] == "home.climate")))
        duplicate[-1]["instanceId"] = "fixture.climate-copy"
        assert client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json={"items": duplicate},
        ).status_code == 422


def test_preset_v2_to_v3_migration_preserves_custom_layout_and_handles_hidden_slot(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=False)
    from panel_agent import overview_layout

    old = overview_layout.shipped_layout(revision=7)
    old["presetVersion"] = 2
    quick = next(item for item in old["items"] if item["instanceId"] == "fixture.climate")
    quick.update({
        "instanceId": "fixture.quick-actions",
        "widgetType": "home.quick-actions",
        "visibility": "hidden",
        "placement": {"x": 4, "y": 11, "w": 7, "h": 2},
        "sizeVariant": "standard",
        "config": {},
    })
    migrated = overview_layout.migrate_preset_v2_to_v3(old)
    climate = next(item for item in migrated["items"] if item["widgetType"] == "home.climate")
    assert migrated["presetVersion"] == 3
    assert climate == {
        "instanceId": "fixture.climate",
        "widgetType": "home.climate",
        "visibility": "hidden",
        "placement": {"x": 4, "y": 11, "w": 7, "h": 4},
        "sizeVariant": "standard",
        "config": {},
    }

    custom_items = [
        item for item in old["items"]
        if item["instanceId"] != "fixture.quick-actions"
    ]
    custom_items[1]["placement"] = {"x": 0, "y": 6, "w": 7, "h": 4}
    custom = {**old, "items": custom_items}
    custom_migrated = overview_layout.migrate_preset_v2_to_v3(custom)
    custom_climate = next(item for item in custom_migrated["items"] if item["widgetType"] == "home.climate")
    assert custom_migrated["presetVersion"] == 3
    assert custom_climate["placement"] == {"x": 0, "y": 1, "w": 7, "h": 4}
    assert {item["instanceId"] for item in custom_migrated["items"] if item["instanceId"] != "fixture.climate"} == {
        item["instanceId"] for item in custom_items
    }


def test_preset_v2_existing_climate_is_not_duplicated_and_read_does_not_write(tmp_path, monkeypatch):
    path = tmp_path / "layout.json"
    module = load_app(monkeypatch, path, writes=False)
    from panel_agent import overview_layout

    stored = overview_layout.shipped_layout(revision=11)
    stored["presetVersion"] = 2
    stored["items"] = [item for item in stored["items"] if item["widgetType"] != "home.quick-actions"]
    original = json.dumps(stored, ensure_ascii=False).encode("utf-8")
    path.write_bytes(original)

    with TestClient(module.app) as client:
        payload = get_layout(client).json()
        assert payload["presetVersion"] == 3
        assert payload["revision"] == 11
        assert len([item for item in payload["items"] if item["widgetType"] == "home.climate"]) == 1
    assert path.read_bytes() == original


def test_preset_v2_exact_climate_migration_reflows_a_collision_without_deleting_widgets():
    from panel_agent import overview_layout

    migrated = overview_layout.migrate_preset_v2_to_v3({
        "schemaVersion": "overview.layout.v2",
        "presetVersion": 2,
        "items": [
            {
                "instanceId": "owner.other",
                "widgetType": "home.coffee-machine",
                "visibility": "visible",
                "placement": {"x": 0, "y": 0, "w": 7, "h": 4},
                "sizeVariant": "standard",
                "config": {},
            },
            {
                "instanceId": "fixture.quick-actions",
                "widgetType": "home.quick-actions",
                "visibility": "visible",
                "placement": {"x": 0, "y": 0, "w": 7, "h": 2},
                "sizeVariant": "standard",
                "config": {},
            },
        ],
    })
    climate = next(item for item in migrated["items"] if item["instanceId"] == "fixture.climate")
    assert climate["placement"] == {"x": 0, "y": 4, "w": 7, "h": 4}
    assert any(item["instanceId"] == "owner.other" for item in migrated["items"])


def test_get_without_file_returns_shipped_v3_and_no_store(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=False)
    with TestClient(module.app) as client:
        response = get_layout(client)
        payload = response.json()
        assert payload["schemaVersion"] == "overview.layout.v2"
        assert payload["presetId"] == "overview.default"
        assert payload["presetVersion"] == 3
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


def test_overview_editor_capability_is_an_effective_runtime_gate(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        # The configured baseline allows the actual endpoint, not just the
        # inventory row.  Disable the immediate capability and re-check live.
        assert client.patch(
            "/api/v1/overview/layout", headers={"If-Match": initial.headers["etag"]},
            json={"items": initial.json()["items"]},
        ).status_code == 200
        inventory = client.get("/api/v1/settings/capabilities").json()
        changed = client.patch("/api/v1/settings/capabilities", json={
            "expectedRevision": inventory["revision"],
            "capabilityId": "overview_layout_editor",
            "enabled": False,
        })
        assert changed.status_code == 200
        disabled = get_layout(client)
        assert disabled.json()["writesEnabled"] is False
        assert client.patch(
            "/api/v1/overview/layout", headers={"If-Match": disabled.headers["etag"]},
            json={"items": disabled.json()["items"]},
        ).status_code == 403


def test_global_write_master_blocks_overview_writes_even_when_local_gate_is_enabled(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True, master_writes=False)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        assert initial.json()["writesEnabled"] is False
        assert client.patch(
            "/api/v1/overview/layout", headers={"If-Match": initial.headers["etag"]},
            json={"items": initial.json()["items"]},
        ).status_code == 403


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


def test_overview_body_below_limit_is_read_and_strictly_validated(tmp_path, monkeypatch):
    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        body = json.dumps({"items": initial.json()["items"]}, separators=(",", ":")).encode("utf-8")
        status_code, headers, response_body = raw_patch(
            module.app,
            body,
            {
                "if-match": initial.headers["etag"],
                "content-type": "application/json",
                "content-length": str(len(body)),
            },
        )
        assert status_code == 200, response_body
        assert headers["etag"] == '"1"'
        assert json.loads(response_body)["revision"] == 1


def test_overview_body_content_length_above_limit_is_rejected_before_parsing(tmp_path, monkeypatch):
    from panel_agent.overview_layout import MAX_REQUEST_BYTES

    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        status_code, _, response_body = raw_patch(
            module.app,
            b"{}",
            {
                "if-match": initial.headers["etag"],
                "content-type": "application/json",
                "content-length": str(MAX_REQUEST_BYTES + 1),
            },
        )
        assert status_code == 413
        assert json.loads(response_body)["detail"] == "overview_layout_request_too_large"


def test_overview_actual_oversized_body_is_rejected_without_or_with_misleading_length(tmp_path, monkeypatch):
    from panel_agent.overview_layout import MAX_REQUEST_BYTES

    path = tmp_path / "layout.json"
    module = load_app(monkeypatch, path, writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        saved = client.patch(
            "/api/v1/overview/layout",
            headers={"If-Match": initial.headers["etag"]},
            json={"items": initial.json()["items"]},
        )
        assert saved.status_code == 200
        old_bytes = path.read_bytes()
        oversized_body = b'{"items":[' + (b"null," * (MAX_REQUEST_BYTES // 4)) + b"]}"

        status_code, _, response_body = raw_patch(
            module.app,
            oversized_body,
            {
                "if-match": saved.headers["etag"],
                "content-type": "application/json",
            },
            chunks=[oversized_body[:MAX_REQUEST_BYTES // 2], oversized_body[MAX_REQUEST_BYTES // 2:]],
        )
        assert status_code == 413
        assert json.loads(response_body)["detail"] == "overview_layout_request_too_large"
        assert path.read_bytes() == old_bytes

        status_code, _, response_body = raw_patch(
            module.app,
            oversized_body,
            {
                "if-match": saved.headers["etag"],
                "content-type": "application/json",
                "content-length": "1",
            },
            chunks=[oversized_body[:MAX_REQUEST_BYTES // 2], oversized_body[MAX_REQUEST_BYTES // 2:]],
        )
        assert status_code == 413
        assert json.loads(response_body)["detail"] == "overview_layout_request_too_large"
        assert path.read_bytes() == old_bytes


def test_overview_invalid_json_is_safe_and_oversized_candidate_is_rejected_before_pydantic(tmp_path, monkeypatch):
    from panel_agent.overview_layout import MAX_REQUEST_BYTES

    path = tmp_path / "layout.json"
    module = load_app(monkeypatch, path, writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        status_code, _, response_body = raw_patch(
            module.app,
            b'{"items":',
            {
                "if-match": initial.headers["etag"],
                "content-type": "application/json",
            },
        )
        assert status_code == 400
        assert json.loads(response_body)["detail"] == "invalid_json"

        oversized_valid_json = b'{"items":[' + (b"null," * (MAX_REQUEST_BYTES // 4)) + b"]}"
        status_code, _, response_body = raw_patch(
            module.app,
            oversized_valid_json,
            {
                "if-match": initial.headers["etag"],
                "content-type": "application/json",
            },
        )
        assert status_code == 413
        assert json.loads(response_body)["detail"] == "overview_layout_request_too_large"
        assert not path.exists()


def test_overview_body_limit_is_deterministic_at_exact_limit(tmp_path, monkeypatch):
    from panel_agent.overview_layout import MAX_REQUEST_BYTES

    module = load_app(monkeypatch, tmp_path / "layout.json", writes=True)
    with TestClient(module.app) as client:
        initial = get_layout(client)
        base_body = json.dumps({"items": initial.json()["items"]}, separators=(",", ":")).encode("utf-8")
        assert len(base_body) < MAX_REQUEST_BYTES
        exact_body = base_body + (b" " * (MAX_REQUEST_BYTES - len(base_body)))
        assert len(exact_body) == MAX_REQUEST_BYTES
        status_code, _, response_body = raw_patch(
            module.app,
            exact_body,
            {
                "if-match": initial.headers["etag"],
                "content-type": "application/json",
                "content-length": str(MAX_REQUEST_BYTES),
            },
        )
        assert status_code == 200, response_body
        saved = json.loads(response_body)
        assert saved["revision"] == 1

        over_limit_body = base_body + (b" " * (MAX_REQUEST_BYTES - len(base_body) + 1))
        status_code, _, response_body = raw_patch(
            module.app,
            over_limit_body,
            {
                "if-match": '"1"',
                "content-type": "application/json",
                "content-length": str(len(over_limit_body)),
            },
        )
        assert status_code == 413
        assert json.loads(response_body)["detail"] == "overview_layout_request_too_large"


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
        assert payload["presetVersion"] == 3
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
