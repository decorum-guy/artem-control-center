"""Validated, server-owned declarative project configuration.

The registry is intentionally closed.  This bridge adds only the registered
AVALAR monitor/details adapters and fixed action IDs; a new YAML key cannot
turn into executable behavior without an explicit server-side registration.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .avalar_actions import (
    avalar_action_target_environment,
    is_registered_avalar_action,
)
from .avalar_health import avalar_target_for_environment, avalar_target_for_url_env


LOGGER = logging.getLogger(__name__)

PROJECT_CONFIG_VERSION = 1
MAX_PROJECT_REGISTRY_REVISION = 2_147_483_647
DEFAULT_PROJECTS_CONFIG_PATH = ".runtime/projects.yaml"
MAX_PROJECT_CONFIG_BYTES = 256 * 1024
MAX_PROJECT_ID_LENGTH = 32
MAX_BACKUP_PROFILE_REFERENCES = 8
MAX_SNAPSHOT_ID_LENGTH = 80
MIN_MONITOR_INTERVAL_SECONDS = 5
MAX_MONITOR_INTERVAL_SECONDS = 3600
MIN_MONITOR_STALE_AFTER_SECONDS = 15
MAX_MONITOR_STALE_AFTER_SECONDS = 24 * 60 * 60

_IDENTIFIER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_ENVIRONMENT_VARIABLE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def stable_service_snapshot_id(project_id: str, environment_id: str, service_id: str) -> str:
    """Return the collision-safe browser service identity for one declaration."""

    return f"{project_id}.{environment_id}.{service_id}"


def _validate_identifier(value: str) -> str:
    if not _IDENTIFIER_PATTERN.fullmatch(value):
        raise ValueError(
            "identifiers must start with a lowercase letter or digit and contain only lowercase letters, digits, '_' or '-'"
        )
    return value


class _ProjectModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ProjectMonitorConfig(_ProjectModel):
    adapter: Literal["http", "avalar"]
    url_env: str = Field(min_length=1, max_length=64)
    interval_seconds: int = Field(
        default=60,
        ge=MIN_MONITOR_INTERVAL_SECONDS,
        le=MAX_MONITOR_INTERVAL_SECONDS,
    )
    stale_after_seconds: int = Field(
        default=180,
        ge=MIN_MONITOR_STALE_AFTER_SECONDS,
        le=MAX_MONITOR_STALE_AFTER_SECONDS,
    )

    @field_validator("url_env")
    @classmethod
    def _safe_url_env(cls, value: str) -> str:
        if not _ENVIRONMENT_VARIABLE_PATTERN.fullmatch(value):
            raise ValueError("url_env must be an uppercase environment-variable identifier")
        return value

    @model_validator(mode="after")
    def _stale_window_is_valid(self) -> "ProjectMonitorConfig":
        if self.stale_after_seconds < self.interval_seconds:
            raise ValueError("stale_after_seconds must be at least interval_seconds")
        if self.adapter == "avalar" and avalar_target_for_url_env(self.url_env) is None:
            raise ValueError("avalar monitor must use a registered AVALAR URL environment variable")
        return self


class ProjectDetailsConfig(_ProjectModel):
    """A registered details adapter with no caller-controlled SSH settings."""

    adapter: Literal["avalar-ssh"]


class ProjectBackupCapabilities(_ProjectModel):
    """Safe project-owned references to server-side backup profiles."""

    profiles: list[str] = Field(default_factory=list, max_length=MAX_BACKUP_PROFILE_REFERENCES)

    @field_validator("profiles")
    @classmethod
    def _profile_ids_are_unique_and_safe(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("duplicate backup profile ID")
        for profile_id in value:
            _validate_identifier(profile_id)
        return value


class ProjectLevelCapabilities(_ProjectModel):
    """Project-level capabilities; implementation details stay server-owned."""

    backups: ProjectBackupCapabilities


class ProjectCapabilities(_ProjectModel):
    monitor: ProjectMonitorConfig
    details: ProjectDetailsConfig | None = None
    actions: list[str] = Field(default_factory=list, max_length=8)
    backupProfile: str | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_PROJECT_ID_LENGTH,
        exclude_if=lambda value: value is None,
    )

    @field_validator("backupProfile")
    @classmethod
    def _backup_profile_id_is_safe(cls, value: str | None) -> str | None:
        if value is not None:
            _validate_identifier(value)
        return value

    @field_validator("actions")
    @classmethod
    def _action_ids_are_non_empty(cls, value: list[str]) -> list[str]:
        if any(not action_id for action_id in value):
            raise ValueError("action IDs must not be empty")
        if any(not is_registered_avalar_action(action_id) for action_id in value):
            raise ValueError("unknown registered action ID")
        return value

    @model_validator(mode="after")
    def _registered_avalar_capabilities(self) -> "ProjectCapabilities":
        if self.details is not None and self.monitor.adapter != "avalar":
            raise ValueError("avalar-ssh details require the registered avalar monitor")
        if self.actions and self.monitor.adapter != "avalar":
            raise ValueError("registered AVALAR actions require the avalar monitor")
        return self


class ProjectPresentation(_ProjectModel):
    widget: str = "core.generic-service"

    @field_validator("widget")
    @classmethod
    def _generic_only(cls, value: str) -> str:
        if value != "core.generic-service":
            raise ValueError("only core.generic-service presentation is supported")
        return value


class ProjectServiceConfig(_ProjectModel):
    id: str = Field(min_length=1, max_length=MAX_PROJECT_ID_LENGTH)
    capabilities: ProjectCapabilities
    presentation: ProjectPresentation = Field(default_factory=ProjectPresentation)

    @field_validator("id")
    @classmethod
    def _valid_id(cls, value: str) -> str:
        return _validate_identifier(value)


class ProjectEnvironmentConfig(_ProjectModel):
    id: str = Field(min_length=1, max_length=MAX_PROJECT_ID_LENGTH)
    services: list[ProjectServiceConfig] = Field(default_factory=list, max_length=64)

    @field_validator("id")
    @classmethod
    def _valid_id(cls, value: str) -> str:
        return _validate_identifier(value)


class ProjectConfig(_ProjectModel):
    id: str = Field(min_length=1, max_length=MAX_PROJECT_ID_LENGTH)
    name: str = Field(min_length=1, max_length=100)
    enabled: bool = True
    category: Literal["external", "work"] = "external"
    capabilities: ProjectLevelCapabilities | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
    )
    environments: list[ProjectEnvironmentConfig] = Field(default_factory=list, max_length=32)

    @field_validator("id")
    @classmethod
    def _valid_id(cls, value: str) -> str:
        return _validate_identifier(value)

    @model_validator(mode="after")
    def _registered_targets_are_safe(self) -> "ProjectConfig":
        declared_backup_profiles = (
            set(self.capabilities.backups.profiles)
            if self.capabilities is not None
            else set()
        )
        for environment in self.environments:
            environment_target = avalar_target_for_environment(environment.id)
            for service in environment.services:
                backup_profile = service.capabilities.backupProfile
                if backup_profile is not None and backup_profile not in declared_backup_profiles:
                    raise ValueError(
                        "service backup profile must be declared by its project"
                    )
                monitor = service.capabilities.monitor
                if monitor.adapter == "avalar":
                    monitor_target = avalar_target_for_url_env(monitor.url_env)
                    if monitor_target is None or environment_target != monitor_target:
                        raise ValueError("avalar monitor target does not match its environment")
                for action_id in service.capabilities.actions:
                    action_target = avalar_action_target_environment(action_id)
                    if action_target is None or environment_target != action_target:
                        raise ValueError("registered action target does not match its environment")
        return self

class ProjectConfigDocument(_ProjectModel):
    version: int
    # Slice A documents omitted this field.  Pydantic's default keeps those
    # documents at the initial revision while mutations persist it explicitly.
    revision: int = Field(default=0, ge=0, le=MAX_PROJECT_REGISTRY_REVISION)
    projects: list[ProjectConfig] = Field(default_factory=list, max_length=128)

    @field_validator("version")
    @classmethod
    def _schema_version(cls, value: int) -> int:
        if value != PROJECT_CONFIG_VERSION:
            raise ValueError(f"unsupported project config version: {value}")
        return value

    @model_validator(mode="after")
    def _identities_are_unique(self) -> "ProjectConfigDocument":
        project_ids: set[str] = set()
        backup_profile_ids: set[str] = set()
        stable_service_ids: set[str] = set()
        registered_action_ids: set[str] = set()

        for project in self.projects:
            if project.id in project_ids:
                raise ValueError("duplicate project identity")
            project_ids.add(project.id)

            if project.capabilities is not None:
                for profile_id in project.capabilities.backups.profiles:
                    if profile_id in backup_profile_ids:
                        raise ValueError("duplicate backup profile identity")
                    backup_profile_ids.add(profile_id)

            environment_ids: set[str] = set()
            for environment in project.environments:
                if environment.id in environment_ids:
                    raise ValueError("duplicate environment identity")
                environment_ids.add(environment.id)

                service_ids: set[str] = set()
                for service in environment.services:
                    if service.id in service_ids:
                        raise ValueError("duplicate service identity")
                    service_ids.add(service.id)

                    stable_id = stable_service_snapshot_id(
                        project.id,
                        environment.id,
                        service.id,
                    )
                    if len(stable_id) > MAX_SNAPSHOT_ID_LENGTH:
                        raise ValueError("stable service identity is too long")
                    if stable_id in stable_service_ids:
                        raise ValueError("duplicate stable service identity")
                    stable_service_ids.add(stable_id)

                    for action_id in service.capabilities.actions:
                        if not is_registered_avalar_action(action_id):
                            raise ValueError("unknown registered action ID")
                        if action_id in registered_action_ids:
                            raise ValueError("duplicate registered action ID")
                        registered_action_ids.add(action_id)

        return self


@dataclass(frozen=True)
class ProjectRegistry:
    """The only project declarations available to runtime adapters."""

    path: Path
    projects: tuple[ProjectConfig, ...] = ()
    revision: int = 0
    available: bool = True
    error_code: str | None = None

    @classmethod
    def empty(cls, path: str | Path) -> "ProjectRegistry":
        return cls(path=Path(path), projects=())

    @classmethod
    def unavailable(cls, path: str | Path, error_code: str) -> "ProjectRegistry":
        return cls(path=Path(path), projects=(), available=False, error_code=error_code)

    @property
    def active_projects(self) -> tuple[ProjectConfig, ...]:
        return tuple(project for project in self.projects if project.enabled)


def load_project_registry(path: str | Path = DEFAULT_PROJECTS_CONFIG_PATH) -> ProjectRegistry:
    """Load one server-owned YAML file, failing closed on any invalid input."""

    config_path = Path(path)
    try:
        resolved_config_path = config_path.resolve()
    except OSError:
        return _unavailable(config_path, "config_read_error")

    # The checked-in example is design input, never a runtime fallback.  This
    # guard also prevents an accidental explicit production path from turning
    # the example into active configuration.
    if (
        config_path.name == "projects.example.yaml"
        or resolved_config_path.name == "projects.example.yaml"
    ):
        return _unavailable(config_path, "example_config_not_runtime")

    try:
        stat = config_path.stat()
    except FileNotFoundError:
        return ProjectRegistry.empty(config_path)
    except OSError:
        return _unavailable(config_path, "config_read_error")

    if not config_path.is_file():
        return _unavailable(config_path, "config_not_a_file")
    if stat.st_size > MAX_PROJECT_CONFIG_BYTES:
        return _unavailable(config_path, "config_too_large")

    try:
        raw_text = config_path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return _unavailable(config_path, "config_read_error")

    try:
        raw_document: Any = yaml.safe_load(raw_text)
    except yaml.YAMLError:
        return _unavailable(config_path, "malformed_yaml")

    if not isinstance(raw_document, Mapping):
        return _unavailable(config_path, "invalid_schema")

    try:
        document = ProjectConfigDocument.model_validate(raw_document)
    except ValidationError:
        # Do not log Pydantic's input-bearing error text: config files may
        # contain values which must never reach logs or browser responses.
        return _unavailable(config_path, "invalid_schema")

    return ProjectRegistry(
        path=config_path,
        projects=tuple(document.projects),
        revision=document.revision,
        available=True,
    )


def _unavailable(path: Path, error_code: str) -> ProjectRegistry:
    LOGGER.warning("declarative project registry unavailable (%s)", error_code)
    return ProjectRegistry.unavailable(path, error_code)
