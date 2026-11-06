from __future__ import annotations

import asyncio
import json
from dataclasses import replace

import httpx
import pytest
from fastapi import FastAPI

from panel_agent.access_middleware import AccessPolicyMiddleware, capability_for_request
from panel_agent.access_policy import AccessPolicyStore
from panel_agent.settings import IntegrationSettings
from panel_agent.todoist import CreateTask, Due, TaskFields, TodoistAdapter, TodoistError, RESPONSE_LIMIT
from panel_agent.todoist_api import build_todoist_router


def task(**fields):
    return dict(id="6Task", project_id="6Project", content="Synthetic task", description="", priority=4, due=None, **fields)


def page(rows=None, cursor=None):
    return {"results": [task()] if rows is None else rows, "next_cursor": cursor}


def settings(**fields):
    return replace(IntegrationSettings(todoist_api_token="synthetic-credential", writes_enabled=True, todoist_writes_enabled=True), **fields)


def run(coro):
    return asyncio.run(coro)


def test_cursor_filter_and_deduplication():
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.params.get("cursor") == "next.cursor":
            return httpx.Response(200, json=page([], None))
        return httpx.Response(200, json=page([task(), task()], "next.cursor"))
    adapter = TodoistAdapter(settings(), transport=httpx.MockTransport(handler))
    async def scenario():
        first = await adapter.page(view="today", limit=2)
        assert len(first["results"]) == 1
        second = await adapter.page(view="today", cursor=first["nextCursor"])
        assert second["nextCursor"] is None
        assert requests[0].url.path == "/api/v1/tasks/filter"
        assert requests[0].url.params["query"] == "today"
        assert requests[1].url.params["cursor"] == "next.cursor"
        assert adapter.status()["state"] == "connected"
    run(scenario())


@pytest.mark.parametrize("view,expected", [("today", "today"), ("overdue", "overdue"), ("upcoming", "due after: today"), ("undated", "no date")])
def test_fixed_filters_keep_cursor_when_project_page_empty(view, expected):
    def handler(request):
        assert request.method == "GET"
        assert request.url.params["query"] == expected
        return httpx.Response(200, json=page(cursor="next"))
    result = run(TodoistAdapter(settings(), transport=httpx.MockTransport(handler)).page(view=view, project_id="OtherProject"))
    assert result["results"] == [] and result["nextCursor"] == "next"


def test_all_tasks_and_projects_paginate():
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=page([{"id": "6Project", "name": "Home"}] if request.url.path.endswith("projects") else [], "page2"))
    adapter = TodoistAdapter(settings(), transport=httpx.MockTransport(handler))
    run(adapter.page(view="all", project_id="6Project"))
    run(adapter.page(projects=True, cursor="page1", limit=200))
    assert requests[0].url.path == "/api/v1/tasks" and requests[0].url.params["project_id"] == "6Project"
    assert requests[1].url.path == "/api/v1/projects" and requests[1].url.params["cursor"] == "page1"


@pytest.mark.parametrize("payload", [{}, [], {"results": [], "next_cursor": 1}, {"results": [{}], "next_cursor": None}, {"results": [], "next_cursor": "bad cursor"}, {"results": [], "next_cursor": "same"}])
def test_malformed_pages(payload):
    adapter = TodoistAdapter(settings(), transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)))
    with pytest.raises(TodoistError, match="malformed_response"):
        run(adapter.page(cursor="same"))


@pytest.mark.parametrize("response,code", [(httpx.Response(200, content="not json"), "malformed_response"), (httpx.Response(200, content=b"x" * (RESPONSE_LIMIT + 1)), "malformed_response"), (httpx.Response(401), "invalid_token"), (httpx.Response(403), "forbidden"), (httpx.Response(429, headers={"Retry-After": "32"}), "rate_limited"), (httpx.Response(503), "upstream_unavailable"), (httpx.Response(302, headers={"Location": "https://elsewhere.test"}), "upstream_unavailable")])
def test_http_errors_redacted_no_redirect_no_retries(response, code, caplog):
    calls = []
    def handler(request):
        calls.append(request)
        return response
    adapter = TodoistAdapter(settings(), transport=httpx.MockTransport(handler))
    with pytest.raises(TodoistError, match=code) as error:
        run(adapter.page())
    if response.status_code == 429:
        assert error.value.retry_after == 32
    assert len(calls) == 1
    assert "synthetic-credential" not in caplog.text + str(error.value) + repr(adapter._settings) + json.dumps(adapter.status())


@pytest.mark.parametrize("operation", ["create", "update", "close", "move"])
@pytest.mark.parametrize("failure", ["timeout", "5xx", "malformed"])
def test_ambiguous_mutations_never_retried(operation, failure):
    calls = []
    def handler(request):
        calls.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("sensitive upstream detail")
        return httpx.Response(503) if failure == "5xx" else httpx.Response(200, content="broken")
    adapter = TodoistAdapter(settings(), transport=httpx.MockTransport(handler))
    if operation == "close" and failure == "malformed":
        run(adapter.mutate(operation, task_id="6Task"))  # close has no response object
    else:
        with pytest.raises(TodoistError, match="outcome_uncertain"):
            run(adapter.mutate(operation, {"content": "Synthetic task"}, "6Task"))
    assert len(calls) == 1
    assert calls[0].method == "POST"


@pytest.mark.parametrize("priority,api", [("p1", 4), ("p2", 3), ("p3", 2), ("p4", 1)])
def test_official_sync_and_doist_cli_priority_semantics(priority, api):
    assert TaskFields(priority=priority).upstream() == {"priority": api}


def test_dates_and_recurrence_preserved_without_date_edit():
    assert TaskFields(due="2026-11-06").upstream() == {"due_date": "2026-11-06"}
    assert TaskFields(due="2026-11-06T12:00:00+03:00").upstream() == {"due_datetime": "2026-11-06T12:00:00+03:00"}
    assert TaskFields(due=None).upstream() == {"due_string": "no date"}
    assert TaskFields(content="New title").upstream() == {"content": "New title"}
    assert Due.model_validate({"date": "2026-11-06T12:00:00", "timezone": None, "is_recurring": True, "string": "every day"}).is_recurring
    assert Due.model_validate({"date": "2026-11-06T09:00:00Z", "timezone": "Europe/Moscow", "is_recurring": True}).timezone == "Europe/Moscow"


@pytest.mark.parametrize("fields", [{}, {"content": " "}, {"content": None}, {"priority": 4}, {"priority": "p5"}, {"description": None}, {"due": "2026-02-30"}, {"due": "2026-11-06T12:00:00"}, {"due": "tomorrow"}, {"project_id": "6Project"}, {"host": "https://evil.test"}, {"content": "x" * 501}])
def test_strict_update_fields(fields):
    with pytest.raises(ValueError):
        TaskFields.model_validate(fields)


def app_client(tmp_path, config=None, profile="standard", handler=None):
    adapter = TodoistAdapter(config or settings(), transport=httpx.MockTransport(handler or (lambda request: httpx.Response(200, json=task()))))
    policy = AccessPolicyStore(tmp_path / "policy.json")
    policy.set_profile(profile)
    app = FastAPI()
    app.add_middleware(AccessPolicyMiddleware, store=policy)
    app.include_router(build_todoist_router(adapter, policy))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test"), adapter


def test_exact_methods_and_close_recurring_refresh(tmp_path):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=page() if request.method == "GET" else task())
    async def scenario():
        client, _ = app_client(tmp_path, handler=handler)
        async with client:
            for path, body in [("tasks", {"content": "New", "priority": "p1", "project_id": "6Project"}), ("tasks/6Task", {"description": "Edited"}), ("tasks/6Task/move", {"project_id": "OtherProject"})]:
                assert (await client.post("/api/v1/todoist/" + path, json=body)).status_code == 200
            assert (await client.post("/api/v1/todoist/tasks/6Task/close")).status_code == 200
            assert (await client.get("/api/v1/todoist/tasks")).status_code == 200
            assert (await client.patch("/api/v1/todoist/tasks/6Task", json={"content": "X"})).status_code == 405
        assert [r.method for r in requests] == ["POST"] * 4 + ["GET"]
        assert [r.url.path for r in requests[:4]] == ["/api/v1/tasks", "/api/v1/tasks/6Task", "/api/v1/tasks/6Task/move", "/api/v1/tasks/6Task/close"]
        assert json.loads(requests[0].content)["priority"] == 4
    run(scenario())


@pytest.mark.parametrize("path,body", [("tasks", {"content": "X"}), ("tasks/6Task", {"content": "X"}), ("tasks/6Task/close", None), ("tasks/6Task/move", {"project_id": "6Project"})])
@pytest.mark.parametrize("gate", ["profile", "global", "todoist", "token_only"])
def test_all_writes_protected(tmp_path, path, body, gate):
    def forbidden(request):
        pytest.fail("write reached upstream")
    config = settings(writes_enabled=gate not in {"global", "token_only"}, todoist_writes_enabled=gate not in {"todoist", "token_only"})
    async def scenario():
        client, _ = app_client(tmp_path, config, "read_only" if gate == "profile" else "standard", forbidden)
        async with client:
            result = await client.post("/api/v1/todoist/" + path, **({"json": body} if body else {}))
            assert result.status_code == (403 if gate == "profile" else 409)
            status = (await client.get("/api/v1/todoist/status")).json()
            assert not status["writesEnabled"]
        assert capability_for_request("POST", "/api/v1/todoist/" + path) == "todoist.tasks.write"
    run(scenario())


@pytest.mark.parametrize("query", ["view=arbitrary", "limit=201", "limit=0", "cursor=" + "a" * 513, "projectId=a/b", "projectId=temp_123", "projectId=temp123", "path=/tasks", "query=all", "host=evil", "view=today&view=all"])
def test_reject_browser_control(tmp_path, query):
    async def scenario():
        client, _ = app_client(tmp_path, handler=lambda request: pytest.fail("invalid request reached upstream"))
        async with client:
            assert (await client.get("/api/v1/todoist/tasks?" + query)).status_code in {400, 422}
            assert (await client.get("/api/v1/todoist/status", headers={"Authorization": "Bearer browser-value"})).status_code == 400
    run(scenario())


@pytest.mark.parametrize("status,code", [(401, "invalid_token"), (403, "forbidden"), (429, "rate_limited")])
def test_rejected_writes_are_safe_and_not_retried(status, code, caplog):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(status, json={"error": "synthetic-credential and private task text"})
    with pytest.raises(TodoistError, match=code) as error:
        run(TodoistAdapter(settings(), transport=httpx.MockTransport(handler)).mutate("create", {"content": "X"}))
    assert len(requests) == 1 and requests[0].method == "POST"
    assert "synthetic-credential" not in str(error.value) + caplog.text


@pytest.mark.parametrize("path,body", [("tasks/6Task", {"content": None}), ("tasks/temp123", {"content": "X"}), ("tasks/6Task", {"project_id": "6Project"}), ("tasks/6Task/move", {"project_id": "bad/id"}), ("tasks", {"content": "X", "authorization": "arbitrary"}), ("tasks/6Task/close", {"extra": True})])
def test_strict_mutation_routes(tmp_path, path, body):
    async def scenario():
        client, _ = app_client(tmp_path, handler=lambda request: pytest.fail("invalid mutation reached upstream"))
        async with client:
            response = await client.post("/api/v1/todoist/" + path, json=body)
            assert response.status_code == 422
    run(scenario())


def test_disabled_fallback_token_activation_and_explicit_false(monkeypatch):
    monkeypatch.setenv("PANEL_TODOIST_API_TOKEN", "synthetic-credential")
    monkeypatch.delenv("PANEL_TODOIST_ENABLED", raising=False)
    config = IntegrationSettings.from_env()
    assert TodoistAdapter(config).enabled and not TodoistAdapter(config).writes_enabled
    monkeypatch.setenv("PANEL_TODOIST_ENABLED", "false")
    assert TodoistAdapter(IntegrationSettings.from_env()).status()["activeSource"] == "planning"
    assert TodoistAdapter(IntegrationSettings()).status()["activeSource"] == "planning"


def test_offline_read_and_mutation_busy():
    def timeout(request):
        raise httpx.ConnectTimeout("sensitive upstream detail")
    with pytest.raises(TodoistError, match="offline"):
        run(TodoistAdapter(settings(), transport=httpx.MockTransport(timeout)).page())
    async def scenario():
        adapter = TodoistAdapter(settings())
        async with adapter._mutation_lock:
            with pytest.raises(TodoistError, match="busy"):
                await adapter.mutate("create", {})
    run(scenario())


def test_cross_origin_writes_blocked(tmp_path):
    async def scenario():
        client, _ = app_client(tmp_path, handler=lambda request: pytest.fail("cross-origin write reached upstream"))
        async with client:
            for headers in [{"Origin": "https://untrusted.test"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}]:
                response = await client.post("/api/v1/todoist/tasks/6Task/close", headers=headers)
                assert response.status_code == 403
    run(scenario())
