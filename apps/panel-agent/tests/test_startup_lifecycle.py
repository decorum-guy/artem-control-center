import asyncio
import importlib
import logging
from queue import Queue

from fastapi.testclient import TestClient


def load_app(monkeypatch, mode: str):
    monkeypatch.setenv("PANEL_AGENT_MODE", mode)
    import panel_agent.main

    return importlib.reload(panel_agent.main)


async def wait_for_task(task: asyncio.Task[None]) -> None:
    await asyncio.wait_for(asyncio.shield(task), timeout=1)


def test_live_is_served_while_integration_bootstrap_is_blocked(monkeypatch):
    module = load_app(monkeypatch, "read_only")
    gates: Queue[tuple[str, asyncio.Event]] = Queue()

    async def start_runtime() -> None:
        release_runtime = asyncio.Event()
        gates.put(("runtime", release_runtime))
        await release_runtime.wait()

    async def rebuild_snapshot() -> None:
        release_snapshot = asyncio.Event()
        gates.put(("snapshot", release_snapshot))
        await release_snapshot.wait()

    monkeypatch.setattr(module.runtime, "start", start_runtime)
    monkeypatch.setattr(module.snapshot_publisher, "rebuild", rebuild_snapshot)

    with TestClient(module.app) as client:
        runtime_gate = gates.get(timeout=1)
        assert runtime_gate[0] == "runtime"
        assert client.get("/health/live").status_code == 200
        starting = client.get("/health/ready")
        assert starting.status_code == 503
        assert starting.json()["reason"] == "panel_starting"

        client.portal.call(runtime_gate[1].set)
        snapshot_gate = gates.get(timeout=1)
        assert snapshot_gate[0] == "snapshot"
        assert client.get("/health/ready").status_code == 503

        client.portal.call(snapshot_gate[1].set)
        client.portal.call(wait_for_task, module.startup_lifecycle.bootstrap_task)
        ready = client.get("/health/ready")
        assert ready.status_code == 200
        assert ready.json()["ok"] is True


def test_bootstrap_failure_keeps_process_live_but_not_ready(monkeypatch, caplog):
    module = load_app(monkeypatch, "read_only")

    async def fail_start() -> None:
        raise RuntimeError("startup-canary")

    monkeypatch.setattr(module.runtime, "start", fail_start)
    caplog.set_level(logging.ERROR, logger="panel_agent.main")

    with TestClient(module.app) as client:
        client.portal.call(wait_for_task, module.startup_lifecycle.bootstrap_task)
        assert client.get("/health/live").status_code == 200
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.json()["reason"] == "panel_startup_failed"
        assert "startup-canary" not in response.text
        assert module.startup_lifecycle.bootstrap_task.exception() is None

    assert "Panel Agent bootstrap failed" in caplog.text
    assert "startup-canary" in caplog.text


def test_shutdown_cancels_and_awaits_blocked_bootstrap(monkeypatch):
    module = load_app(monkeypatch, "read_only")
    signals: Queue[str] = Queue()

    async def block_start() -> None:
        signals.put("started")
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            signals.put("cancelled")
            raise

    monkeypatch.setattr(module.runtime, "start", block_start)

    with TestClient(module.app) as client:
        assert signals.get(timeout=1) == "started"
        task = module.startup_lifecycle.bootstrap_task
        assert task is not None
        assert not task.done()

    assert task.done()
    assert task.cancelled()
    assert signals.get(timeout=1) == "cancelled"
    assert module.startup_lifecycle.phase == "stopping"


def test_production_scheduler_starts_after_bootstrap_and_closes_before_runtime(monkeypatch):
    module = load_app(monkeypatch, "production")
    calls: list[str] = []

    async def start_runtime() -> None:
        calls.append("runtime.start")

    async def rebuild_snapshot() -> None:
        calls.append("snapshot.rebuild")

    async def start_scheduler() -> None:
        calls.append("scheduler.start")

    async def close_scheduler() -> None:
        calls.append("scheduler.close")

    async def close_snapshot() -> None:
        calls.append("snapshot.close")

    async def close_runtime() -> None:
        calls.append("runtime.close")

    monkeypatch.setattr(module.runtime, "start", start_runtime)
    monkeypatch.setattr(module.runtime, "close", close_runtime)
    monkeypatch.setattr(module.snapshot_publisher, "rebuild", rebuild_snapshot)
    monkeypatch.setattr(module.snapshot_publisher, "close", close_snapshot)
    monkeypatch.setattr(module.coffee_delayed_start_scheduler, "start", start_scheduler)
    monkeypatch.setattr(module.coffee_delayed_start_scheduler, "close", close_scheduler)

    with TestClient(module.app) as client:
        client.portal.call(wait_for_task, module.startup_lifecycle.bootstrap_task)
        assert client.get("/health/ready").status_code == 200
        assert calls == ["runtime.start", "snapshot.rebuild", "scheduler.start"]

    assert calls == [
        "runtime.start",
        "snapshot.rebuild",
        "scheduler.start",
        "scheduler.close",
        "runtime.close",
        "snapshot.close",
    ]
