"""Bounded startup migrations for reserved production registry entries."""

from __future__ import annotations

from .project_registry import ProjectConfig, ProjectRegistry
from .project_registry_store import (
    ProjectRegistryProjectExists,
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


class ProjectRegistryMigrationError(RuntimeError):
    """A bounded, non-sensitive error raised by startup provisioning."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def canonical_avalar_project() -> ProjectConfig:
    """Return the reserved AVALAR definition required in production."""

    environments = []
    for environment_id, url_env in (
        ("main", "PANEL_AVALAR_MAIN_URL"),
        ("stage", "PANEL_AVALAR_STAGE_URL"),
    ):
        environments.append(
            {
                "id": environment_id,
                "services": [
                    {
                        "id": "website",
                        "capabilities": {
                            "monitor": {
                                "adapter": "avalar",
                                "url_env": url_env,
                                "interval_seconds": 60,
                                "stale_after_seconds": 180,
                            },
                            "details": {"adapter": "avalar-ssh"},
                            "actions": list(_AVALAR_ACTIONS_BY_ENVIRONMENT[environment_id]),
                        },
                        "presentation": {"widget": "core.generic-service"},
                    }
                ],
            }
        )
    return ProjectConfig.model_validate(
        {
            "id": CANONICAL_AVALAR_PROJECT_ID,
            "name": "AVALAR",
            "enabled": True,
            "category": "work",
            "environments": environments,
        }
    )


def ensure_canonical_avalar_project(
    store: ProjectRegistryStore,
) -> ProjectRegistry:
    """Atomically ensure AVALAR without overwriting an existing owner entry."""

    canonical = canonical_avalar_project()
    for _attempt in range(2):
        current = store.read()
        _require_available(current)
        existing = _find_project(current, CANONICAL_AVALAR_PROJECT_ID)
        if existing is not None:
            _require_canonical(existing, canonical)
            return current
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
