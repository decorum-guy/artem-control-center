from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.integrations import IntegrationRuntime
from panel_agent.project_registry import ProjectRegistry, load_project_registry
from panel_agent.project_registry_api import build_project_registry_router
from panel_agent.project_registry_migration import (
    ProjectRegistryMigrationError,
    canonical_avalar_project,
    ensure_canonical_avalar_project,
)
from panel_agent.project_registry_store import ProjectRegistryStore
from panel_agent.snapshot import SnapshotPublisher
from panel_agent.settings import IntegrationSettings


def _project(*, project_id: str = "external-api", enabled: bool = True) -> dict:
    return {
        "id": project_id,
        "name": "External API",
        "enabled": enabled,
        "category": "external",
        "environments": [
            {
                "id": "production",
                "services": [
                    {
                        "id": "api",
                        "capabilities": {
                            "monitor": {
                                "adapter": "http",
                                "url_env": "EXTERNAL_API_HEALTH_URL",
                                "interval_seconds": 5,
                                "stale_after_seconds": 15,
                            },
                            "actions": [],
                        },
                        "presentation": {"widget": "core.generic-service"},
                    }
                ],
            }
        ],
    }


def _document(*projects: dict) -> dict:
    return {"version": 1, "projects": list(projects)}


def _write(path, document: dict) -> None:
    path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")


class _FakeRuntime:
    def __init__(self) -> None:
        self.registries: list[ProjectRegistry] = []

    async def replace_project_registry(self, registry: ProjectRegistry) -> None:
        self.registries.append(registry)


def _client(
    path,
    *,
    writes_allowed: bool = True,
    runtime=None,
    rebuild=None,
    protected_project_ids=frozenset(),
):
    store = ProjectRegistryStore(path)
    runtime = runtime or _FakeRuntime()
    rebuild_calls = []

    async def snapshot_rebuild():
        rebuild_calls.append(True)

    app = FastAPI()
    app.include_router(
        build_project_registry_router(
            store,
            runtime,
            snapshot_rebuild=rebuild or snapshot_rebuild,
            writes_allowed=lambda: writes_allowed,
            protected_project_ids=protected_project_ids,
        )
    )
    return store, runtime, rebuild_calls, TestClient(app)


def _body(project=None, *, revision: int = 0) -> dict:
    return {"expectedRevision": revision, "project": project or _project()}


def test_slice_a_document_without_revision_loads_as_revision_zero(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, _document(_project()))

    registry = load_project_registry(path)

    assert registry.available is True
    assert registry.revision == 0


@pytest.mark.parametrize("write_empty_document", [False, True])
def test_provisioning_missing_or_empty_registry_creates_one_canonical_avalar(
    tmp_path,
    write_empty_document,
):
    path = tmp_path / "projects.yaml"
    if write_empty_document:
        _write(path, _document())

    store = ProjectRegistryStore(path)
    provisioned = ensure_canonical_avalar_project(store)

    assert provisioned.available is True
    assert provisioned.revision == 1
    assert provisioned.projects == (canonical_avalar_project(),)
    assert provisioned.projects[0].environments[0].services[0].capabilities.monitor.url_env == (
        "PANEL_AVALAR_MAIN_URL"
    )
    serialized = json.dumps(provisioned.projects[0].model_dump(mode="json"))
    assert "https://" not in serialized
    assert "main.test" not in serialized
    assert "stage.test" not in serialized
    assert all(value not in serialized for value in ("host", "remote", "key", "token"))


def test_provisioning_preserves_unrelated_projects_unchanged(tmp_path):
    path = tmp_path / "projects.yaml"
    unrelated = _project(project_id="unrelated")
    _write(path, {"version": 1, "revision": 4, "projects": [unrelated]})
    before = load_project_registry(path).projects[0]

    provisioned = ensure_canonical_avalar_project(ProjectRegistryStore(path))

    assert provisioned.revision == 5
    assert provisioned.projects[0] == before
    assert [project.id for project in provisioned.projects] == [
        "unrelated",
        "avalar",
    ]


def test_exact_canonical_provisioning_is_idempotent_without_revision_bump(tmp_path):
    path = tmp_path / "projects.yaml"
    first = ensure_canonical_avalar_project(ProjectRegistryStore(path))
    before = path.read_bytes()

    second = ensure_canonical_avalar_project(ProjectRegistryStore(path))

    assert first.revision == 1
    assert second.revision == 1
    assert second.projects == (canonical_avalar_project(),)
    assert path.read_bytes() == before


def test_conflicting_avalar_project_fails_closed_without_overwrite(tmp_path):
    path = tmp_path / "projects.yaml"
    conflicting = canonical_avalar_project().model_copy(update={"name": "Owner AVALAR"})
    _write(
        path,
        {
            "version": 1,
            "revision": 8,
            "projects": [conflicting.model_dump(mode="python")],
        },
    )
    before = path.read_bytes()

    with pytest.raises(ProjectRegistryMigrationError) as error:
        ensure_canonical_avalar_project(ProjectRegistryStore(path))

    assert error.value.code == "avalar_definition_conflict"
    assert path.read_bytes() == before
    assert load_project_registry(path).projects[0].name == "Owner AVALAR"


@pytest.mark.parametrize("corrupt_as_directory", [False, True])
def test_unavailable_or_corrupt_registry_is_never_overwritten(
    tmp_path,
    corrupt_as_directory,
):
    path = tmp_path / "projects.yaml"
    if corrupt_as_directory:
        path.mkdir()
    else:
        path.write_text("version: [1\nprojects: []\n", encoding="utf-8")
    before = path.read_bytes() if path.is_file() else None

    with pytest.raises(ProjectRegistryMigrationError) as error:
        ensure_canonical_avalar_project(ProjectRegistryStore(path))

    assert error.value.code == "registry_unavailable"
    if before is not None:
        assert path.read_bytes() == before
    else:
        assert path.is_dir()


def test_get_missing_registry_is_sanitized_empty_and_readable(tmp_path):
    _, _, _, client = _client(tmp_path / "projects.yaml")

    response = client.get("/api/v1/settings/projects")

    assert response.status_code == 200
    assert response.json() == {
        "schemaVersion": "project.registry.v1",
        "revision": 0,
        "available": True,
        "errorCode": None,
        "projects": [],
        "writesEnabled": True,
        "manageCapability": "settings.projects.manage",
        "manageMinimumProfile": "full",
    }


def test_get_existing_registry_exposes_only_sanitized_monitor_fields(tmp_path, monkeypatch):
    path = tmp_path / "projects.yaml"
    _write(path, _document(_project()))
    endpoint = "https://private.example.test/health"
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", endpoint)
    _, _, _, client = _client(path)

    response = client.get("/api/v1/settings/projects")

    assert response.status_code == 200
    payload = response.json()
    assert payload["revision"] == 0
    assert payload["projects"][0]["enabled"] is True
    assert payload["projects"][0]["environments"][0]["services"][0] == {
        "id": "api",
        "monitor": {
            "adapter": "http",
            "urlEnv": "EXTERNAL_API_HEALTH_URL",
            "intervalSeconds": 5,
            "staleAfterSeconds": 15,
        },
        "actions": [],
        "presentation": {"widget": "core.generic-service"},
    }
    serialized = json.dumps(payload)
    assert endpoint not in serialized
    assert str(path) not in serialized
    assert "projects_config_path" not in serialized


def test_create_persists_revision_once_and_reconciles(tmp_path):
    path = tmp_path / "projects.yaml"
    store, runtime, rebuild_calls, client = _client(path)

    response = client.post("/api/v1/settings/projects", json=_body())

    assert response.status_code == 201
    assert response.json()["revision"] == 1
    assert len(runtime.registries) == 1
    assert len(rebuild_calls) == 1
    persisted = load_project_registry(path)
    assert persisted.revision == 1
    assert [project.id for project in persisted.projects] == ["external-api"]
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert raw["revision"] == 1
    assert store.read().revision == 1


def test_duplicate_create_is_conflict_without_writing_or_reconciling(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, _document(_project()))
    runtime = _FakeRuntime()
    _, _, _, client = _client(path, runtime=runtime)
    before = path.read_bytes()

    response = client.post("/api/v1/settings/projects", json=_body())

    assert response.status_code == 409
    assert response.json() == {"detail": "project_exists"}
    assert path.read_bytes() == before
    assert runtime.registries == []


def test_update_replaces_project_and_supports_project_level_disable(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, _document(_project()))
    runtime = _FakeRuntime()
    _, _, _, client = _client(path, runtime=runtime)
    update = _project(enabled=False)
    update["name"] = "External API disabled"

    response = client.patch(
        "/api/v1/settings/projects/external-api",
        json=_body(update),
    )

    assert response.status_code == 200
    assert response.json()["revision"] == 1
    assert response.json()["projects"][0]["enabled"] is False
    saved = load_project_registry(path)
    assert saved.revision == 1
    assert saved.projects[0].enabled is False
    assert runtime.registries[-1].projects[0].enabled is False


def test_update_project_id_mismatch_is_rejected_without_file_change(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, _document(_project()))
    _, runtime, _, client = _client(path)
    before = path.read_bytes()
    payload = _body(_project(project_id="other-project"))

    response = client.put(
        "/api/v1/settings/projects/external-api",
        json=payload,
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "project_id_mismatch"}
    assert path.read_bytes() == before
    assert runtime.registries == []


def test_delete_removes_project_and_increments_revision(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, _document(_project()))
    runtime = _FakeRuntime()
    _, _, rebuild_calls, client = _client(path, runtime=runtime)

    response = client.request(
        "DELETE",
        "/api/v1/settings/projects/external-api",
        json={"expectedRevision": 0},
    )

    assert response.status_code == 200
    assert response.json()["revision"] == 1
    assert response.json()["projects"] == []
    assert load_project_registry(path).projects == ()
    assert len(runtime.registries) == 1
    assert len(rebuild_calls) == 1


def test_protected_project_cannot_be_created_without_file_or_reconciliation(tmp_path):
    path = tmp_path / "projects.yaml"
    runtime = _FakeRuntime()
    _, _, rebuild_calls, client = _client(
        path,
        runtime=runtime,
        protected_project_ids={"avalar"},
    )

    response = client.post(
        "/api/v1/settings/projects",
        json=_body(_project(project_id="avalar")),
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "project_reserved"}
    assert not path.exists()
    assert runtime.registries == []
    assert rebuild_calls == []


@pytest.mark.parametrize("method", ["PUT", "PATCH"])
def test_protected_project_cannot_be_replaced_without_mutation_or_reconciliation(
    tmp_path,
    method,
):
    path = tmp_path / "projects.yaml"
    _write(path, {"version": 1, "revision": 7, "projects": [_project(project_id="avalar")]})
    runtime = _FakeRuntime()
    _, _, rebuild_calls, client = _client(
        path,
        runtime=runtime,
        protected_project_ids={"avalar"},
    )
    before = path.read_bytes()

    response = client.request(
        method,
        "/api/v1/settings/projects/avalar",
        json=_body(_project(project_id="avalar", enabled=False), revision=7),
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "project_reserved"}
    assert path.read_bytes() == before
    assert load_project_registry(path).revision == 7
    assert runtime.registries == []
    assert rebuild_calls == []


def test_protected_project_cannot_be_deleted_without_mutation_or_reconciliation(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, {"version": 1, "revision": 7, "projects": [_project(project_id="avalar")]})
    runtime = _FakeRuntime()
    _, _, rebuild_calls, client = _client(
        path,
        runtime=runtime,
        protected_project_ids={"avalar"},
    )
    before = path.read_bytes()

    response = client.request(
        "DELETE",
        "/api/v1/settings/projects/avalar",
        json={"expectedRevision": 7},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "project_reserved"}
    assert path.read_bytes() == before
    assert load_project_registry(path).revision == 7
    assert runtime.registries == []
    assert rebuild_calls == []


def test_protected_project_get_remains_available(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, {"version": 1, "revision": 7, "projects": [_project(project_id="avalar")]})
    _, _, _, client = _client(path, protected_project_ids={"avalar"})

    response = client.get("/api/v1/settings/projects")

    assert response.status_code == 200
    assert response.json()["revision"] == 7
    assert response.json()["projects"][0]["id"] == "avalar"


def test_stale_revision_returns_409_without_file_or_runtime_change(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, _document(_project()))
    _, runtime, _, client = _client(path)
    before = path.read_bytes()

    response = client.post(
        "/api/v1/settings/projects",
        json=_body(_project(project_id="new-project"), revision=7),
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "revision_conflict"}
    assert path.read_bytes() == before
    assert runtime.registries == []


def test_invalid_mutation_is_sanitized_and_changes_nothing(tmp_path):
    path = tmp_path / "projects.yaml"
    runtime = _FakeRuntime()
    _, _, _, client = _client(path, runtime=runtime)
    invalid = _body()
    invalid["project"]["token"] = "do-not-echo-this-secret"

    response = client.post("/api/v1/settings/projects", json=invalid)

    assert response.status_code == 422
    assert response.json() == {"detail": "invalid_project_payload"}
    assert "do-not-echo-this-secret" not in response.text
    assert not path.exists()
    assert runtime.registries == []


def test_corrupt_registry_cannot_be_overwritten_by_crud(tmp_path):
    path = tmp_path / "projects.yaml"
    path.write_text("version: [1\nprojects: []\n", encoding="utf-8")
    _, runtime, _, client = _client(path)
    before = path.read_bytes()

    inventory = client.get("/api/v1/settings/projects")
    mutation = client.post("/api/v1/settings/projects", json=_body())

    assert inventory.status_code == 200
    assert inventory.json()["available"] is False
    assert inventory.json()["errorCode"] == "malformed_yaml"
    assert mutation.status_code == 503
    assert path.read_bytes() == before
    assert runtime.registries == []


def test_example_yaml_is_never_a_writable_runtime_config(tmp_path):
    path = tmp_path / "projects.example.yaml"
    _write(path, _document())
    _, runtime, _, client = _client(path)
    before = path.read_bytes()

    response = client.post("/api/v1/settings/projects", json=_body())

    assert response.status_code == 503
    assert response.json() == {"detail": "example_config_not_runtime"}
    assert path.read_bytes() == before
    assert runtime.registries == []


def test_writes_disabled_is_denied_before_store_mutation(tmp_path):
    path = tmp_path / "projects.yaml"
    _, runtime, _, client = _client(path, writes_allowed=False)

    response = client.post("/api/v1/settings/projects", json=_body())

    assert response.status_code == 403
    assert response.json() == {"detail": "project_registry_write_disabled"}
    assert not path.exists()
    assert runtime.registries == []


class _Transport(httpx.AsyncBaseTransport):
    def __init__(self, handler):
        self.handler = handler
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        return await self.handler(request)


def _runtime_settings() -> IntegrationSettings:
    return IntegrationSettings(
        http_request_timeout_seconds=1,
        integration_unavailable_after_seconds=300,
        integration_max_backoff_seconds=120,
    )


def _runtime_registry(projects=()) -> ProjectRegistry:
    document = {"version": 1, "revision": 0, "projects": list(projects)}
    from panel_agent.project_registry import ProjectConfigDocument

    parsed = ProjectConfigDocument.model_validate(document)
    return ProjectRegistry(path="<test>", projects=tuple(parsed.projects))


def test_runtime_reconciliation_materializes_disable_reenable_delete_without_restart(
    monkeypatch,
):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "https://monitor.test/health")

    async def handler(request):
        return httpx.Response(200)

    async def exercise():
        transport = _Transport(handler)
        runtime = IntegrationRuntime(
            _runtime_settings(),
            project_registry=_runtime_registry([_project(project_id="seed")]),
            project_monitor_transport=transport,
        )
        publisher = SnapshotPublisher(mode="read_only", services_builder=runtime.services)
        runtime.set_snapshot_callback(publisher.rebuild)
        await publisher.rebuild()
        await runtime.project_monitor.start()
        first_monitor = runtime.project_monitor
        initial_snapshot_revision = publisher.revision
        existing_ids = {
            service.id
            for service in runtime.services()
            if service.id != "external-api.production.api"
        }

        enabled = _runtime_registry([_project(project_id="seed"), _project()])
        await runtime.replace_project_registry(enabled)
        await publisher.rebuild()
        assert "external-api.production.api" in {service.id for service in runtime.services()}
        assert first_monitor.running is False
        assert runtime.project_monitor.running is True
        assert existing_ids <= {service.id for service in runtime.services()}
        assert publisher.revision > initial_snapshot_revision

        disabled = _runtime_registry([_project(project_id="seed"), _project(enabled=False)])
        old_monitor = runtime.project_monitor
        await runtime.replace_project_registry(disabled)
        await publisher.rebuild()
        assert old_monitor.running is False
        assert runtime.project_monitor.running is True
        assert "external-api.production.api" not in {service.id for service in runtime.services()}

        reenabled = _runtime_registry([_project(project_id="seed"), _project()])
        old_monitor = runtime.project_monitor
        await runtime.replace_project_registry(reenabled)
        await publisher.rebuild()
        assert old_monitor.running is False
        assert runtime.project_monitor.running is True
        assert "external-api.production.api" in {service.id for service in runtime.services()}

        deleted = _runtime_registry([_project(project_id="seed")])
        old_monitor = runtime.project_monitor
        await runtime.replace_project_registry(deleted)
        await publisher.rebuild()
        assert old_monitor.running is False
        assert runtime.project_monitor.running is True
        assert "external-api.production.api" not in {service.id for service in runtime.services()}
        assert len([task for task in asyncio.all_tasks() if task.get_name() == "declarative-project-monitor" and not task.done()]) <= 1
        await runtime.close()
        await publisher.close()

    asyncio.run(exercise())


def test_offline_declared_endpoint_does_not_roll_back_valid_runtime_reconciliation(
    monkeypatch,
):
    monkeypatch.setenv("EXTERNAL_API_HEALTH_URL", "https://offline.monitor.test/health")

    async def handler(request):
        raise httpx.ConnectError("offline", request=request)

    async def exercise():
        transport = _Transport(handler)
        runtime = IntegrationRuntime(
            _runtime_settings(),
            project_registry=_runtime_registry(),
            project_monitor_transport=transport,
        )
        await runtime.project_monitor.start()
        saved = _runtime_registry([_project()])
        await runtime.replace_project_registry(saved)
        await runtime.project_monitor.start()
        assert runtime.project_registry.revision == 0
        assert runtime.project_monitor.services()[0].health == "offline"
        assert runtime.project_monitor.services()[0].source == "unavailable"
        assert transport.calls == 1
        await runtime.close()

    asyncio.run(exercise())
