"""Fixed local routes; browser credentials and arbitrary queries are rejected."""
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Query, Request, Response

from .access_policy import AccessPolicyStore
from .todoist import CreateTask, Cursor, MoveTask, MutationAccepted, ProjectPage, ProviderId, Status, TaskFields, TaskPage, TodoistAdapter, TodoistError, View


def build_todoist_router(adapter: TodoistAdapter, access: AccessPolicyStore) -> APIRouter:
    router = APIRouter(prefix="/api/v1/todoist")

    async def boundary(request: Request, response: Response, allowed=()):
        response.headers["Cache-Control"] = "no-store"
        if "authorization" in request.headers or any(key not in allowed for key in request.query_params):
            raise HTTPException(400, "unsupported_todoist_input")
        if request.method == "POST":
            origin = request.headers.get("origin")
            if request.headers.get("sec-fetch-site") == "cross-site" or (
                origin is not None and (
                    urlsplit(origin).scheme not in {"http", "https"}
                    or urlsplit(origin).netloc != request.url.netloc
                )
            ):
                raise HTTPException(403, "cross_origin_write_forbidden")
        if any(len(request.query_params.getlist(key)) > 1 for key in request.query_params):
            raise HTTPException(400, "duplicate_parameter")

    async def call(awaitable):
        try:
            return await awaitable
        except TodoistError as exc:
            headers = {"Cache-Control": "no-store"}
            if exc.retry_after is not None:
                headers["Retry-After"] = str(exc.retry_after)
            raise HTTPException(exc.status, exc.code, headers=headers) from None

    @router.get("/status", response_model=Status)
    async def status(request: Request, response: Response):
        await boundary(request, response)
        status = adapter.status()
        status["writesEnabled"] = adapter.writes_enabled and access.authorize("todoist.tasks.write").allowed
        return status

    @router.get("/tasks", response_model=TaskPage)
    async def tasks(request: Request, response: Response, view: View = "today", projectId: ProviderId | None = None,
                    cursor: Cursor | None = None, limit: Annotated[int, Query(ge=1, le=200)] = 50):
        await boundary(request, response, ("view", "projectId", "cursor", "limit"))
        return await call(adapter.page(view=view, project_id=projectId, cursor=cursor, limit=limit))

    @router.get("/projects", response_model=ProjectPage)
    async def projects(request: Request, response: Response, cursor: Cursor | None = None,
                       limit: Annotated[int, Query(ge=1, le=200)] = 50):
        await boundary(request, response, ("cursor", "limit"))
        return await call(adapter.page(projects=True, cursor=cursor, limit=limit))

    @router.post("/tasks", response_model=MutationAccepted)
    async def create(body: CreateTask, request: Request, response: Response):
        await boundary(request, response)
        access.require("todoist.tasks.write")
        return await call(adapter.mutate("create", body.upstream()))

    @router.post("/tasks/{task_id}", response_model=MutationAccepted)
    async def update(task_id: ProviderId, body: TaskFields, request: Request, response: Response):
        await boundary(request, response)
        access.require("todoist.tasks.write")
        return await call(adapter.mutate("update", body.upstream(), task_id))

    @router.post("/tasks/{task_id}/move", response_model=MutationAccepted)
    async def move(task_id: ProviderId, body: MoveTask, request: Request, response: Response):
        await boundary(request, response)
        access.require("todoist.tasks.write")
        return await call(adapter.mutate("move", body.model_dump(), task_id))

    @router.post("/tasks/{task_id}/close", response_model=MutationAccepted)
    async def close(task_id: ProviderId, request: Request, response: Response):
        await boundary(request, response)
        access.require("todoist.tasks.write")
        if await request.body():
            raise HTTPException(422, "close_body_forbidden")
        return await call(adapter.mutate("close", task_id=task_id))

    return router
