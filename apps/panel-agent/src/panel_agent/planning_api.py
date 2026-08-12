"""Narrow same-origin read surface backed by the normalized Planning adapter."""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.datastructures import QueryParams

from .planning import (
    PlanningReadEnvelope,
    PlanningStatusProjection,
    validate_uuid4,
    validate_utc_timestamp,
)
from .planning_adapter import PlanningAdapter, PlanningReadUnavailable, PlanningUpstreamError


def build_planning_router(
    adapter: PlanningAdapter,
    *,
    prefix: str = "/api/v1/planning",
) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["planning"])

    @router.get("/status", response_model=PlanningStatusProjection)
    async def planning_status(request: Request, response: Response) -> PlanningStatusProjection:
        del request
        _enabled(adapter)
        _no_store(response)
        return adapter.read_status()

    @router.get("/reminders", response_model=PlanningReadEnvelope)
    async def planning_reminders(request: Request, response: Response) -> PlanningReadEnvelope:
        _enabled(adapter)
        _no_store(response)
        query = _query(request, allowed={"state", "from", "to", "limit", "offset"})
        state = query.get("state")
        if state is not None and state not in {"pending", "due", "completed", "cancelled"}:
            raise HTTPException(status_code=422, detail="planning_state_invalid")
        from_utc, to_utc = _optional_range(query)
        try:
            return await adapter.read_reminders(
                state=state,
                from_utc=from_utc,
                to_utc=to_utc,
                limit=_limit(query),
                offset=_offset(query),
            )
        except (PlanningReadUnavailable, PlanningUpstreamError) as exc:
            raise _read_unavailable() from exc

    @router.get("/tasks", response_model=PlanningReadEnvelope)
    async def planning_tasks(request: Request, response: Response) -> PlanningReadEnvelope:
        _enabled(adapter)
        _no_store(response)
        query = _query(request, allowed={"view", "projectId", "limit", "offset"})
        view = query.get("view")
        if view not in {"today", "overdue", "upcoming"}:
            raise HTTPException(status_code=422, detail="planning_view_required")
        project_id = query.get("projectId")
        if project_id is not None:
            try:
                validate_uuid4(project_id, "planning.projectId")
            except ValueError as exc:
                raise HTTPException(status_code=422, detail="planning_project_id_invalid") from exc
        try:
            return await adapter.read_tasks(
                view=view,  # type: ignore[arg-type]
                project_id=project_id,
                limit=_limit(query),
                offset=_offset(query),
            )
        except (PlanningReadUnavailable, PlanningUpstreamError) as exc:
            raise _read_unavailable() from exc

    @router.get("/events", response_model=PlanningReadEnvelope)
    async def planning_events(request: Request, response: Response) -> PlanningReadEnvelope:
        _enabled(adapter)
        _no_store(response)
        query = _query(request, allowed={"from", "to", "limit", "offset"})
        from_utc, to_utc = _required_range(query)
        try:
            return await adapter.read_events(
                from_utc=from_utc,
                to_utc=to_utc,
                limit=_limit(query),
                offset=_offset(query),
            )
        except (PlanningReadUnavailable, PlanningUpstreamError) as exc:
            raise _read_unavailable() from exc

    @router.get("/projects", response_model=PlanningReadEnvelope)
    async def planning_projects(request: Request, response: Response) -> PlanningReadEnvelope:
        _enabled(adapter)
        _no_store(response)
        query = _query(request, allowed={"limit", "offset"})
        try:
            return await adapter.read_projects(limit=_limit(query), offset=_offset(query))
        except (PlanningReadUnavailable, PlanningUpstreamError) as exc:
            raise _read_unavailable() from exc

    return router


def _enabled(adapter: PlanningAdapter) -> None:
    if not adapter.enabled:
        raise HTTPException(status_code=404, detail="planning_disabled")


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def _read_unavailable() -> HTTPException:
    """Never turn a bounded summary cache into a false complete route page."""

    return HTTPException(status_code=503, detail="planning_read_unavailable")


def _query(request: Request, *, allowed: set[str]) -> dict[str, str]:
    params: QueryParams = request.query_params
    unknown = set(params.keys()) - allowed
    if unknown:
        raise HTTPException(status_code=422, detail="planning_query_not_allowlisted")
    result: dict[str, str] = {}
    for key, value in params.multi_items():
        if key in result or len(value) > 128:
            raise HTTPException(status_code=422, detail="planning_query_invalid")
        result[key] = value
    return result


def _limit(query: dict[str, str]) -> int:
    return _positive_int(query.get("limit", "20"), maximum=100, code="planning_limit_invalid")


def _offset(query: dict[str, str]) -> int:
    return _nonnegative_int(query.get("offset", "0"), maximum=10_000, code="planning_offset_invalid")


def _positive_int(value: str, *, maximum: int, code: str) -> int:
    if not value.isdigit() or not 1 <= int(value) <= maximum:
        raise HTTPException(status_code=422, detail=code)
    return int(value)


def _nonnegative_int(value: str, *, maximum: int, code: str) -> int:
    if not value.isdigit() or not 0 <= int(value) <= maximum:
        raise HTTPException(status_code=422, detail=code)
    return int(value)


def _optional_range(query: dict[str, str]) -> tuple[str | None, str | None]:
    from_utc, to_utc = query.get("from"), query.get("to")
    if (from_utc is None) != (to_utc is None):
        raise HTTPException(status_code=422, detail="planning_range_requires_both")
    if from_utc is None:
        return None, None
    _validate_range(from_utc, to_utc)
    return from_utc, to_utc


def _required_range(query: dict[str, str]) -> tuple[str, str]:
    from_utc, to_utc = query.get("from"), query.get("to")
    if from_utc is None or to_utc is None:
        raise HTTPException(status_code=422, detail="planning_range_required")
    _validate_range(from_utc, to_utc)
    return from_utc, to_utc


def _validate_range(from_utc: str, to_utc: str | None) -> None:
    if to_utc is None:
        raise HTTPException(status_code=422, detail="planning_range_requires_both")
    try:
        validate_utc_timestamp(from_utc, "planning.from")
        validate_utc_timestamp(to_utc, "planning.to")
        from_value = datetime.fromisoformat(from_utc[:-1] + "+00:00")
        to_value = datetime.fromisoformat(to_utc[:-1] + "+00:00")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="planning_range_invalid") from exc
    if to_value <= from_value or to_value - from_value > timedelta(days=366):
        raise HTTPException(status_code=422, detail="planning_range_invalid")
