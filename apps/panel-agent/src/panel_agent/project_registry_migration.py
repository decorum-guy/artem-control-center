"""Bounded startup migrations for reserved production registry entries."""

from __future__ import annotations

from .project_registry import ProjectConfig, ProjectRegistry
from .project_registry_store import (
    ProjectRegistryProjectExists,
    ProjectRegistryProjectNotFound,
    ProjectRegistryRevisionConflict,
    ProjectRegistryStore,
    ProjectRegistryStoreError,
)

CANONICAL_AVALAR_PROJECT_ID = "avalar"
CANONICAL_AVALAR_SERVICE_IDS = (
    "avalar.main.website",
    "avalar.stage.website",
)

_AVALAR_ACTIONS_BY_ENVIRONMENT = {
    "main": [
        "avalar.main.smoke",
        "avalar.main.restart",
        "avalar.main.deploy",
    ],
    "stage": [
        "avalar.stage.smoke",
        "avalar.stage.restart",
        "avalar.stage.deploy",
    ],
}

_AVALAR_BACKUP_PROFILE_IDS = (
    "avalar-main-site",
    "avalar-stage-site",
)


class ProjectRegistryMigrationError(RuntimeError):
    """A bounded, non-sensitive error raised by startup provisioning."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _build_canonical_avalar_project(*, include_backup_profiles: bool) -> ProjectConfig:
    """Build one of the two server-owned canonical AVALAR definitions."""

    environments: list[dict] = []
    for environment_id, url_env in (
        ("main", "PANEL_AVALAR_MAIN_URL"),
        ("stage", "PANEL_AVALAR_STAGE_URL"),
    ):
        capabilities = {
            "monitor": {
                "adapter": "avalar",
                "url_env": url_env,
                "interval_seconds": 60,
                "stale_after_seconds": 180,
            },
            "details": {"adapter": "avalar-ssh"},
            "actions": list(_AVALAR_ACTIONS_BY_ENVIRONMENT[environment_id]),
        }
        if include_backup_profiles:
            capabilities["backupProfile"] = f"avalar-{environment_id}-site"
        environments.append(
            {
                "id": environment_id,
                "services": [
                    {
                        "id": "website",
                        "capabilities": capabilities,
                        "presentation": {"widget": "core.generic-service"},
                    }
                ],
            }
        )
    project: dict = {
        "id": CANONICAL_AVALAR_PROJECT_ID,
        "name": "AVALAR",
        "enabled": True,
        "category": "work",
        "environments": environments,
    }
    if include_backup_profiles:
        project["capabilities"] = {
            "backups": {"profiles": list(_AVALAR_BACKUP_PROFILE_IDS)}
        }
    return ProjectConfig.model_validate(project)


def canonical_avalar_project() -> ProjectConfig:
    """Return the current reserved AVALAR definition required in production."""

    return _build_canonical_avalar_project(include_backup_profiles=True)


def _legacy_canonical_avalar_project() -> ProjectConfig:
    """Return the exact pre-B1 reserved AVALAR definition."""

    return _build_canonical_avalar_project(include_backup_profiles=False)


def ensure_canonical_avalar_project(
    store: ProjectRegistryStore,
) -> ProjectRegistry:
    """Atomically provision or upgrade only the server-owned AVALAR definition."""

    canonical = canonical_avalar_project()
    legacy = _legacy_canonical_avalar_project()
    for _attempt in range(2):
        current = store.read()
        _require_available(current)
        existing = _find_project(current, CANONICAL_AVALAR_PROJECT_ID)
        if existing is not None:
            if existing == canonical:
                return current
            if existing != legacy:
                _require_canonical(existing, canonical)
            try:
                return store.replace(canonical, expected_revision=current.revision)
            except (ProjectRegistryProjectNotFound, ProjectRegistryRevisionConflict):
                # Re-read once so a concurrent mutation can be re-evaluated
                # against the current or legacy server-owned definition.
                continue
            except ProjectRegistryStoreError as exc:
                raise ProjectRegistryMigrationError("registry_provision_failed") from exc
        try:
            return store.create(canonical, expected_revision=current.revision)
        except (ProjectRegistryProjectExists, ProjectRegistryRevisionConflict):
            # Re-read once so a concurrent canonical create can be observed
            # idempotently; any other owner data is handled by the next pass.
            continue
        except ProjectRegistryStoreError as exc:
            raise ProjectRegistryMigrationError("registry_provision_failed") from exc

    current = store.read()
    _require_available(current)
    existing = _find_project(current, CANONICAL_AVALAR_PROJECT_ID)
    if existing is not None:
        if existing == canonical:
            return current
        if existing == legacy:
            raise ProjectRegistryMigrationError("registry_changed_during_provisioning")
        _require_canonical(existing, canonical)
        return current
    raise ProjectRegistryMigrationError("registry_changed_during_provisioning")


def _find_project(registry: ProjectRegistry, project_id: str) -> ProjectConfig | None:
    return next(
        (project for project in registry.projects if project.id == project_id),
        None,
    )


def _require_available(registry: ProjectRegistry) -> None:
    if not registry.available:
        raise ProjectRegistryMigrationError("registry_unavailable")


def _require_canonical(project: ProjectConfig, canonical: ProjectConfig) -> None:
    if project != canonical:
        raise ProjectRegistryMigrationError("avalar_definition_conflict")
