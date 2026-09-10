"""Revisioned, atomic persistence for the server-owned project registry."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from threading import RLock
from typing import Callable

import yaml
from pydantic import ValidationError

from .project_registry import (
    MAX_PROJECT_CONFIG_BYTES,
    MAX_PROJECT_REGISTRY_REVISION,
    PROJECT_CONFIG_VERSION,
    ProjectConfig,
    ProjectConfigDocument,
    ProjectRegistry,
    load_project_registry,
)


class ProjectRegistryStoreError(ValueError):
    """A safe, browser-facing project registry storage error code."""


class ProjectRegistryUnavailable(ProjectRegistryStoreError):
    pass


class ProjectRegistryRevisionConflict(ProjectRegistryStoreError):
    pass


class ProjectRegistryProjectExists(ProjectRegistryStoreError):
    pass


class ProjectRegistryProjectNotFound(ProjectRegistryStoreError):
    pass


class ProjectRegistryInvalidCandidate(ProjectRegistryStoreError):
    pass


class ProjectRegistryWriteFailed(ProjectRegistryStoreError):
    pass


class ProjectRegistryStore:
    """One process-local revision-checked store for one runtime YAML path."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._mutation_lock = RLock()

    def read(self) -> ProjectRegistry:
        with self._mutation_lock:
            return load_project_registry(self.path)

    def create(self, project: ProjectConfig, *, expected_revision: int) -> ProjectRegistry:
        def update(projects: list[ProjectConfig]) -> list[ProjectConfig]:
            if any(existing.id == project.id for existing in projects):
                raise ProjectRegistryProjectExists("project_exists")
            return [*projects, project.model_copy(deep=True)]

        return self._mutate(expected_revision, update)

    def replace(self, project: ProjectConfig, *, expected_revision: int) -> ProjectRegistry:
        def update(projects: list[ProjectConfig]) -> list[ProjectConfig]:
            for index, existing in enumerate(projects):
                if existing.id == project.id:
                    replaced = list(projects)
                    replaced[index] = project.model_copy(deep=True)
                    return replaced
            raise ProjectRegistryProjectNotFound("project_not_found")

        return self._mutate(expected_revision, update)

    def delete(self, project_id: str, *, expected_revision: int) -> ProjectRegistry:
        def update(projects: list[ProjectConfig]) -> list[ProjectConfig]:
            if not any(existing.id == project_id for existing in projects):
                raise ProjectRegistryProjectNotFound("project_not_found")
            return [project for project in projects if project.id != project_id]

        return self._mutate(expected_revision, update)

    def _mutate(
        self,
        expected_revision: int,
        update: Callable[[list[ProjectConfig]], list[ProjectConfig]],
    ) -> ProjectRegistry:
        with self._mutation_lock:
            current = load_project_registry(self.path)
            if not current.available:
                raise ProjectRegistryUnavailable(
                    current.error_code or "stored_registry_unavailable"
                )
            if current.revision != expected_revision:
                raise ProjectRegistryRevisionConflict("revision_conflict")
            if expected_revision >= MAX_PROJECT_REGISTRY_REVISION:
                raise ProjectRegistryInvalidCandidate("revision_exhausted")

            try:
                projects = update(list(current.projects))
                document = ProjectConfigDocument.model_validate(
                    {
                        "version": PROJECT_CONFIG_VERSION,
                        "revision": expected_revision + 1,
                        "projects": [
                            project.model_dump(mode="python") for project in projects
                        ],
                    }
                )
            except (ValidationError, TypeError, ValueError) as exc:
                if isinstance(exc, ProjectRegistryStoreError):
                    raise
                raise ProjectRegistryInvalidCandidate("invalid_project_config") from exc

            encoded = self._serialize(document)
            self._atomic_write(encoded)
            return ProjectRegistry(
                path=self.path,
                projects=tuple(document.projects),
                revision=document.revision,
                available=True,
            )

    @staticmethod
    def _serialize(document: ProjectConfigDocument) -> bytes:
        try:
            encoded = yaml.safe_dump(
                document.model_dump(mode="python"),
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            ).encode("utf-8")
        except (TypeError, ValueError, yaml.YAMLError) as exc:
            raise ProjectRegistryWriteFailed("registry_serialization_failed") from exc
        if len(encoded) > MAX_PROJECT_CONFIG_BYTES:
            raise ProjectRegistryWriteFailed("registry_too_large")
        return encoded

    def _atomic_write(self, encoded: bytes) -> None:
        if _is_example_path(self.path):
            raise ProjectRegistryUnavailable("example_config_not_runtime")

        temporary_path: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=self.path.parent,
                delete=False,
            ) as handle:
                temporary_path = Path(handle.name)
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
            temporary_path = None
            _fsync_directory(self.path.parent)
        except OSError as exc:
            raise ProjectRegistryWriteFailed("registry_write_failed") from exc
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass


def _is_example_path(path: Path) -> bool:
    if path.name == "projects.example.yaml":
        return True
    try:
        return path.resolve().name == "projects.example.yaml"
    except OSError:
        return False


def _fsync_directory(path: Path) -> None:
    """Persist the directory entry where the atomic replace occurred."""

    try:
        directory_flags = getattr(os, "O_DIRECTORY", 0)
        descriptor = os.open(str(path), os.O_RDONLY | directory_flags)
    except OSError:
        # Some supported platforms do not permit opening directories for fsync;
        # the file itself was already flushed before replace.
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)
