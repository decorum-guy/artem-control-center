from __future__ import annotations

import copy

import pytest
import yaml

from panel_agent.project_registry import (
    DEFAULT_PROJECTS_CONFIG_PATH,
    load_project_registry,
    stable_service_snapshot_id,
)
from panel_agent.settings import IntegrationSettings


def _document() -> dict:
    return {
        "version": 1,
        "projects": [
            {
                "id": "external-api",
                "name": "External API",
                "enabled": True,
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
                                        "interval_seconds": 60,
                                        "stale_after_seconds": 180,
                                    },
                                    "actions": [],
                                },
                                "presentation": {"widget": "core.generic-service"},
                            }
                        ],
                    }
                ],
            }
        ],
    }


def _write(path, document: dict) -> None:
    path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")


def test_valid_monitor_only_external_project_loads(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, _document())

    registry = load_project_registry(path)

    assert registry.available is True
    assert registry.error_code is None
    assert [project.id for project in registry.projects] == ["external-api"]
    service = registry.projects[0].environments[0].services[0]
    assert service.capabilities.monitor.adapter == "http"
    assert service.capabilities.monitor.url_env == "EXTERNAL_API_HEALTH_URL"
    assert service.capabilities.actions == []
    assert stable_service_snapshot_id("external-api", "production", "api") == (
        "external-api.production.api"
    )


def test_zero_actions_is_valid(tmp_path):
    path = tmp_path / "projects.yaml"
    _write(path, _document())

    registry = load_project_registry(path)

    assert registry.projects[0].environments[0].services[0].capabilities.actions == []


def test_project_and_service_backup_profile_declarations_load(tmp_path):
    document = _document()
    project = document["projects"][0]
    project["capabilities"] = {
        "backups": {"profiles": ["avalar-main-site", "avalar-stage-site"]}
    }
    project["environments"][0]["services"][0]["capabilities"]["backupProfile"] = (
        "avalar-stage-site"
    )
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is True
    assert registry.projects[0].capabilities is not None
    assert registry.projects[0].capabilities.backups.profiles == [
        "avalar-main-site",
        "avalar-stage-site",
    ]
    assert (
        registry.projects[0]
        .environments[0]
        .services[0]
        .capabilities.backupProfile
        == "avalar-stage-site"
    )


def test_duplicate_project_backup_profile_ids_are_rejected(tmp_path):
    document = _document()
    document["projects"][0]["capabilities"] = {
        "backups": {"profiles": ["avalar-stage-site", "avalar-stage-site"]}
    }
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


def test_service_backup_profile_must_be_declared_by_project(tmp_path):
    document = _document()
    document["projects"][0]["capabilities"] = {
        "backups": {"profiles": ["avalar-main-site"]}
    }
    document["projects"][0]["environments"][0]["services"][0]["capabilities"][
        "backupProfile"
    ] = "avalar-stage-site"
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


@pytest.mark.parametrize(
    "profile_id",
    [
        "../secret",
        "/tmp/foo",
        r"C:\foo",
        "https://example.test/backup",
        "avalar stage site",
        "avalar\nstage",
    ],
)
def test_unsafe_backup_profile_ids_are_rejected(tmp_path, profile_id):
    document = _document()
    document["projects"][0]["capabilities"] = {
        "backups": {"profiles": [profile_id]}
    }
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


@pytest.mark.parametrize(
    "profile_id",
    ["../secret", "/tmp/foo", r"C:\foo", "https://example.test/backup", "avalar stage"],
)
def test_unsafe_service_backup_profile_ids_are_rejected(tmp_path, profile_id):
    document = _document()
    document["projects"][0]["capabilities"] = {
        "backups": {"profiles": ["avalar-stage-site"]}
    }
    document["projects"][0]["environments"][0]["services"][0]["capabilities"][
        "backupProfile"
    ] = profile_id
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


def test_unknown_backup_capability_fields_are_rejected(tmp_path):
    document = _document()
    document["projects"][0]["capabilities"] = {
        "backups": {"profiles": [], "paths": ["/tmp/secret"]}
    }
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


def test_missing_project_config_is_an_empty_available_registry(tmp_path):
    registry = load_project_registry(tmp_path / "missing-projects.yaml")

    assert registry.available is True
    assert registry.error_code is None
    assert registry.projects == ()


def test_default_path_is_runtime_owned_and_does_not_point_to_example():
    assert DEFAULT_PROJECTS_CONFIG_PATH == ".runtime/projects.yaml"


def test_runtime_config_path_is_server_setting(monkeypatch):
    monkeypatch.setenv("PANEL_PROJECTS_CONFIG_PATH", "/server-owned/projects.yaml")

    assert IntegrationSettings.from_env().projects_config_path == "/server-owned/projects.yaml"


def test_example_config_is_never_activated(tmp_path):
    example = tmp_path / "projects.example.yaml"
    _write(example, _document())

    registry = load_project_registry(example)

    assert registry.available is False
    assert registry.error_code == "example_config_not_runtime"
    assert registry.projects == ()


def test_malformed_yaml_fails_closed(tmp_path):
    path = tmp_path / "projects.yaml"
    path.write_text("version: [1\nprojects: []\n", encoding="utf-8")

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "malformed_yaml"
    assert registry.projects == ()


def test_unknown_keys_are_rejected_without_partial_application(tmp_path):
    document = _document()
    document["projects"][0]["unexpected"] = "reject-me"
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


@pytest.mark.parametrize("field", ["token", "password", "secret", "api_key", "auth_headers"])
def test_raw_secret_fields_are_rejected(tmp_path, field):
    document = _document()
    document["projects"][0]["environments"][0]["services"][0]["capabilities"][field] = (
        {"Authorization": "not-forwarded"} if field == "auth_headers" else "not-forwarded"
    )
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


def test_unsupported_monitor_adapter_is_rejected(tmp_path):
    document = _document()
    document["projects"][0]["environments"][0]["services"][0]["capabilities"]["monitor"][
        "adapter"
    ] = "ssh"
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


def test_unsupported_write_capability_is_rejected(tmp_path):
    document = _document()
    document["projects"][0]["environments"][0]["services"][0]["capabilities"][
        "deploy"
    ] = {"action_id": "external.deploy"}
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


def test_non_empty_actions_are_rejected(tmp_path):
    document = _document()
    document["projects"][0]["environments"][0]["services"][0]["capabilities"]["actions"] = [
        "external.restart"
    ]
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()


def test_duplicate_stable_service_identity_is_rejected(tmp_path):
    document = _document()
    duplicate = copy.deepcopy(document["projects"][0]["environments"][0]["services"][0])
    document["projects"][0]["environments"][0]["services"].append(duplicate)
    path = tmp_path / "projects.yaml"
    _write(path, document)

    registry = load_project_registry(path)

    assert registry.available is False
    assert registry.error_code == "invalid_schema"
    assert registry.projects == ()
