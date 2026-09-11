"""Sanitized Settings API for the monitor-only project registry."""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Literal

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .project_monitor import (
    DeclarativeHttpProbeResult,
    probe_declarative_http_monitor,
)
from .project_registry import (
    MAX_MONITOR_INTERVAL_SECONDS,
    MAX_MONITOR_STALE_AFTER_SECONDS,
    MIN_MONITOR_INTERVAL_SECONDS,
    MIN_MONITOR_STALE_AFTER_SECONDS,
    ProjectConfig,
    ProjectMonitorConfig,
    ProjectRegistry,
)
from .project_registry_store import (
    ProjectRegistryInvalidCandidate,
    ProjectRegistryProjectExists,
    ProjectRegistryProjectNotFound,
    ProjectRegistryRevisionConflict,
    ProjectRegistryStore,
    ProjectRegistryStoreError,
    ProjectRegistryUnavailable,
    ProjectRegistryWriteFailed,
)
from .settings import IntegrationSettings


PROJECT_REGISTRY_SCHEMA_VERSION = "project.registry.v1"
PROJECT_REGISTRY_CAPABILITY = "settings.projects.manage"
PROJECT_REGISTRY_MINIMUM_PROFILE = "full"
MAX_PROJECT_REGISTRY_REQUEST_BYTES = 256 * 1024
PROJECT_CONNECTION_TEST_SCHEMA_VERSION = "project.connection-test.v1"

ProjectRegistryErrorCode = Literal[
    "config_read_error",
    "config_not_a_file",
    "config_too_large",
    "malformed_yaml",
    "invalid_schema",
    "example_config_not_runtime",
    "config_unavailable",
]


class ProjectRegistryMonitorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    adapter: Literal["http"]
    urlEnv: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$", max_length=64)
    intervalSeconds: int = Field(
        ge=MIN_MONITOR_INTERVAL_SECONDS,
        le=MAX_MONITOR_INTERVAL_SECONDS,
    )
    staleAfterSeconds: int = Field(
        ge=MIN_MONITOR_STALE_AFTER_SECONDS,
        le=MAX_MONITOR_STALE_AFTER_SECONDS,
    )


class ProjectRegistryPresentationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    widget: Literal["core.generic-service"]


class ProjectRegistryServiceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(min_length=1, max_length=32, pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$")
    monitor: ProjectRegistryMonitorResponse
    actions: list[str] = Field(default_factory=list, max_length=0)
    presentation: ProjectRegistryPresentationResponse


class ProjectRegistryEnvironmentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(min_length=1, max_length=32, pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$")
    services: list[ProjectRegistryServiceResponse] = Field(default_factory=list, max_length=64)


class ProjectRegistryProjectResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(min_length=1, max_length=32, pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$")
    name: str = Field(min_length=1, max_length=100)
    enabled: bool
    category: Literal["external"]
    environments: list[ProjectRegistryEnvironmentResponse] = Field(default_factory=list, max_length=32)


class ProjectRegistryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schemaVersion: Literal["project.registry.v1"]
    revision: int = Field(ge=0)
    available: bool
    errorCode: ProjectRegistryErrorCode | None = None
    projects: list[ProjectRegistryProjectResponse] = Field(default_factory=list, max_length=128)
    writesEnabled: bool
    manageCapability: Literal["settings.projects.manage"]
    manageMinimumProfile: Literal["full"]


class ProjectRegistryMutationRequest(BaseModel):
    """A full canonical Slice A project replacement plus its expected revision."""

    model_config = ConfigDict(extra="forbid", strict=True)

    expectedRevision: int = Field(ge=0, le=2_147_483_647)
    project: ProjectConfig


class ProjectRegistryDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    expectedRevision: int = Field(ge=0, le=2_147_483_647)


ProjectConnectionTestResult = Literal[
    "reachable",
    "endpoint_not_configured",
    "endpoint_invalid",
    "http_error",
    "unreachable",
]


class ProjectConnectionTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    project: ProjectConfig
    environmentId: str = Field(
        min_length=1,
        max_length=32,
        pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$",
    )
    serviceId: str = Field(
        min_length=1,
        max_length=32,
        pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$",
    )


class ProjectConnectionTestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schemaVersion: Literal["project.connection-test.v1"]
    result: ProjectConnectionTestResult
    reachable: bool
    httpStatus: int | None = Field(default=None, ge=100, le=599)
    latencyMs: int | None = Field(default=None, ge=0, le=30_000)
    projectId: str = Field(
        min_length=1,
        max_length=32,
        pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$",
    )
    environmentId: str = Field(
        min_length=1,
        max_length=32,
        pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$",
    )
    serviceId: str = Field(
        min_length=1,
        max_length=32,
        pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$",
    )

    @model_validator(mode="after")
    def _result_fields_are_consistent(self) -> "ProjectConnectionTestResponse":
        if self.reachable is not (self.result == "reachable"):
            raise ValueError("reachable does not match result")
        if self.result == "reachable" and self.httpStatus is None:
            raise ValueError("reachable requires an HTTP status")
        if self.result in {"reachable", "http_error"} and self.latencyMs is None:
            raise ValueError("HTTP result requires latency")
        if self.result in {"endpoint_not_configured", "endpoint_invalid", "unreachable"}:
            if self.httpStatus is not None or self.latencyMs is not None:
                raise ValueError("non-HTTP result cannot expose response metadata")
        return self


def build_project_registry_router(
    store: ProjectRegistryStore,
    runtime: Any,
    *,
    snapshot_rebuild: Callable[[], Awaitable[Any]],
    writes_allowed: Callable[[], bool],
    connection_test_settings: IntegrationSettings | None = None,
    connection_test_transport: httpx.AsyncBaseTransport | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/settings/projects", tags=["settings"])
    probe_settings = connection_test_settings or IntegrationSettings()

    @router.get("", response_model=ProjectRegistryResponse)
    def get_projects(response: Response) -> ProjectRegistryResponse:
        registry = store.read()
        writes_enabled = _writes_enabled(registry, writes_allowed)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Project-Registry-Writes-Enabled"] = str(writes_enabled).lower()
        response.headers["ETag"] = f'"{registry.revision}"'
        return _response(registry, writes_enabled=writes_enabled)

    @router.post(
        "/test-connection",
        response_model=ProjectConnectionTestResponse,
    )
    async def test_connection(
        request: Request,
        response: Response,
    ) -> ProjectConnectionTestResponse:
        payload = await _parse_payload(request, ProjectConnectionTestRequest)
        monitor = _connection_monitor(payload)
        probe = await probe_declarative_http_monitor(
            monitor,
            probe_settings,
            transport=connection_test_transport,
        )
        response.headers["Cache-Control"] = "no-store"
        return _connection_test_response(payload, probe)

    @router.post("", response_model=ProjectRegistryResponse, status_code=status.HTTP_201_CREATED)
    async def create_project(request: Request, response: Response) -> ProjectRegistryResponse:
        payload = await _parse_payload(request, ProjectRegistryMutationRequest)
        _require_writes(writes_allowed)
        try:
            saved = store.create(
                payload.project,
                expected_revision=payload.expectedRevision,
            )
        except ProjectRegistryStoreError as exc:
            _raise_store_error(exc)
        saved = await _reconcile(runtime, saved, snapshot_rebuild)
        return _mutation_response(response, saved, writes_allowed)

    @router.api_route(
        "/{project_id}",
        methods=["PUT", "PATCH"],
        response_model=ProjectRegistryResponse,
    )
    async def replace_project(
        project_id: str,
        request: Request,
        response: Response,
    ) -> ProjectRegistryResponse:
        payload = await _parse_payload(request, ProjectRegistryMutationRequest)
        _require_writes(writes_allowed)
        if payload.project.id != project_id:
            raise HTTPException(status_code=422, detail="project_id_mismatch")
        try:
            saved = store.replace(
                payload.project,
                expected_revision=payload.expectedRevision,
            )
        except ProjectRegistryStoreError as exc:
            _raise_store_error(exc)
        saved = await _reconcile(runtime, saved, snapshot_rebuild)
        return _mutation_response(response, saved, writes_allowed)

    @router.delete("/{project_id}", response_model=ProjectRegistryResponse)
    async def delete_project(
        project_id: str,
        request: Request,
        response: Response,
    ) -> ProjectRegistryResponse:
        payload = await _parse_payload(request, ProjectRegistryDeleteRequest)
        _require_writes(writes_allowed)
        try:
            saved = store.delete(
                project_id,
                expected_revision=payload.expectedRevision,
            )
        except ProjectRegistryStoreError as exc:
            _raise_store_error(exc)
        saved = await _reconcile(runtime, saved, snapshot_rebuild)
        return _mutation_response(response, saved, writes_allowed)

    return router


def _connection_monitor(
    payload: ProjectConnectionTestRequest,
) -> ProjectMonitorConfig:
    environments = [
        candidate
        for candidate in payload.project.environments
        if candidate.id == payload.environmentId
    ]
    if len(environments) != 1:
        raise HTTPException(status_code=422, detail="unknown_environment")
    environment = environments[0]

    services = [
        candidate
        for candidate in environment.services
        if candidate.id == payload.serviceId
    ]
    if len(services) != 1:
        raise HTTPException(status_code=422, detail="unknown_service")
    return services[0].capabilities.monitor


def _connection_test_response(
    payload: ProjectConnectionTestRequest,
    probe: DeclarativeHttpProbeResult,
) -> ProjectConnectionTestResponse:
    return ProjectConnectionTestResponse(
        schemaVersion=PROJECT_CONNECTION_TEST_SCHEMA_VERSION,
        result=probe.result,
        reachable=probe.result == "reachable",
        httpStatus=probe.http_status,
        latencyMs=probe.latency_ms,
        projectId=payload.project.id,
        environmentId=payload.environmentId,
        serviceId=payload.serviceId,
    )


def _response(registry: ProjectRegistry, *, writes_enabled: bool) -> ProjectRegistryResponse:
    return ProjectRegistryResponse(
        schemaVersion=PROJECT_REGISTRY_SCHEMA_VERSION,
        revision=registry.revision,
        available=registry.available,
        errorCode=_safe_error_code(registry.error_code) if not registry.available else None,
        projects=[
            ProjectRegistryProjectResponse(
                id=project.id,
                name=project.name,
                enabled=project.enabled,
                category=project.category,
                environments=[
                    ProjectRegistryEnvironmentResponse(
                        id=environment.id,
                        services=[
                            ProjectRegistryServiceResponse(
                                id=service.id,
                                monitor=ProjectRegistryMonitorResponse(
                                    adapter=service.capabilities.monitor.adapter,
                                    urlEnv=service.capabilities.monitor.url_env,
                                    intervalSeconds=service.capabilities.monitor.interval_seconds,
                                    staleAfterSeconds=service.capabilities.monitor.stale_after_seconds,
                                ),
                                actions=[],
                                presentation=ProjectRegistryPresentationResponse(
                                    widget=service.presentation.widget,
                                ),
                            )
                            for service in environment.services
                        ],
                    )
                    for environment in project.environments
                ],
            )
            for project in registry.projects
        ],
        writesEnabled=writes_enabled,
        manageCapability=PROJECT_REGISTRY_CAPABILITY,
        manageMinimumProfile=PROJECT_REGISTRY_MINIMUM_PROFILE,
    )


def _writes_enabled(
    registry: ProjectRegistry,
    writes_allowed: Callable[[], bool],
) -> bool:
    return registry.available and bool(writes_allowed())


def _mutation_response(
    response: Response,
    registry: ProjectRegistry,
    writes_allowed: Callable[[], bool],
) -> ProjectRegistryResponse:
    writes_enabled = _writes_enabled(registry, writes_allowed)
    response.headers["Cache-Control"] = "no-store"
    response.headers["ETag"] = f'"{registry.revision}"'
    response.headers["X-Project-Registry-Writes-Enabled"] = str(writes_enabled).lower()
    return _response(registry, writes_enabled=writes_enabled)


def _require_writes(writes_allowed: Callable[[], bool]) -> None:
    if not writes_allowed():
        raise HTTPException(status_code=403, detail="project_registry_write_disabled")


async def _reconcile(
    runtime: Any,
    registry: ProjectRegistry,
    snapshot_rebuild: Callable[[], Awaitable[Any]],
) -> ProjectRegistry:
    try:
        await runtime.replace_project_registry(registry)
        await snapshot_rebuild()
    except Exception as exc:
        # The file is deliberately not rewritten here.  The store has already
        # committed a valid revision, and the runtime swap closes the old
        # monitor before any new task can be started.
        raise HTTPException(
            status_code=503,
            detail="project_registry_runtime_reconciliation_failed",
        ) from exc
    return registry


async def _parse_payload(request: Request, model_type: type[BaseModel]) -> BaseModel:
    raw_body = await _read_bounded_body(request)
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="invalid_json")
    try:
        return model_type.model_validate(payload)
    except ValidationError as exc:
        # Do not return Pydantic's input-bearing error structure: a rejected
        # request may contain a secret-bearing field which must not be echoed.
        raise HTTPException(status_code=422, detail="invalid_project_payload") from exc


async def _read_bounded_body(request: Request) -> bytes:
    declared_length = request.headers.get("content-length")
    if declared_length is not None:
        try:
            declared_bytes = int(declared_length)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid_content_length")
        if declared_bytes < 0:
            raise HTTPException(status_code=400, detail="invalid_content_length")
        if declared_bytes > MAX_PROJECT_REGISTRY_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="project_registry_request_too_large")

    chunks: list[bytes] = []
    total_bytes = 0
    async for chunk in request.stream():
        total_bytes += len(chunk)
        if total_bytes > MAX_PROJECT_REGISTRY_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="project_registry_request_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def _raise_store_error(exc: ProjectRegistryStoreError) -> None:
    if isinstance(exc, ProjectRegistryRevisionConflict):
        raise HTTPException(status_code=409, detail="revision_conflict")
    if isinstance(exc, ProjectRegistryProjectExists):
        raise HTTPException(status_code=409, detail="project_exists")
    if isinstance(exc, ProjectRegistryProjectNotFound):
        raise HTTPException(status_code=404, detail="project_not_found")
    if isinstance(exc, ProjectRegistryInvalidCandidate):
        raise HTTPException(status_code=422, detail=_safe_store_code(str(exc)))
    if isinstance(exc, ProjectRegistryWriteFailed):
        raise HTTPException(status_code=503, detail=_safe_store_code(str(exc)))
    if isinstance(exc, ProjectRegistryUnavailable):
        raise HTTPException(status_code=503, detail=_safe_store_code(str(exc)))
    raise HTTPException(status_code=503, detail="project_registry_unavailable")


def _safe_error_code(value: str | None) -> ProjectRegistryErrorCode | None:
    if value in {
        "config_read_error",
        "config_not_a_file",
        "config_too_large",
        "malformed_yaml",
        "invalid_schema",
        "example_config_not_runtime",
    }:
        return value  # type: ignore[return-value]
    return "config_unavailable" if value else None


def _safe_store_code(value: str) -> str:
    allowed = {
        "config_read_error",
        "config_not_a_file",
        "config_too_large",
        "malformed_yaml",
        "invalid_schema",
        "invalid_project_config",
        "example_config_not_runtime",
        "revision_exhausted",
        "registry_serialization_failed",
        "registry_too_large",
        "registry_write_failed",
    }
    return value if value in allowed else "project_registry_unavailable"
