"""Validated, server-owned declarative project configuration.

Slice A intentionally accepts only monitor-only external HTTP services.  The
registry is a closed schema so a future capability cannot become active just
because a new key appeared in a YAML file.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator


LOGGER = logging.getLogger(__name__)

PROJECT_CONFIG_VERSION = 1
MAX_PROJECT_REGISTRY_REVISION = 2_147_483_647
DEFAULT_PROJECTS_CONFIG_PATH = ".runtime/projects.yaml"
MAX_PROJECT_CONFIG_BYTES = 256 * 1024
MAX_PROJECT_ID_LENGTH = 32
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
    adapter: str = Field(min_length=1)
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

    @field_validator("adapter")
    @classmethod
    def _http_only(cls, value: str) -> str:
        if value != "http":
            raise ValueError("only the http monitor adapter is supported")
        return value

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
        return self


class ProjectCapabilities(_ProjectModel):
    monitor: ProjectMonitorConfig
    # Slice A deliberately permits the explicit empty action list only.  The
    # field is retained in the schema so monitor-only declarations are clear
    # and future write capabilities cannot be activated accidentally.
    actions: list[str] = Field(default_factory=list, max_length=0)


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
    category: str
    environments: list[ProjectEnvironmentConfig] = Field(default_factory=list, max_length=32)

    @field_validator("id")
    @classmethod
    def _valid_id(cls, value: str) -> str:
        return _validate_identifier(value)

    @field_validator("category")
    @classmethod
    def _external_only(cls, value: str) -> str:
        if value != "external":
            raise ValueError("only external projects are supported in Slice A")
        return value


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
        stable_service_ids: set[str] = set()

        for project in self.projects:
            if project.id in project_ids:
                raise ValueError("duplicate project identity")
            project_ids.add(project.id)

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
