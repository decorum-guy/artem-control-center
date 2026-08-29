from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.system_update import (
    GitCommandResult,
    PanelUpdateService,
    build_system_update_router,
    capability_apply_active,
    software_update_active,
)

CURRENT = "a" * 40
TARGET = "b" * 40
CHANGED_TARGET = "c" * 40
REQUEST = "0" * 24


class FakeGit:
    def __init__(
        self,
        *,
        current=CURRENT,
        target=TARGET,
        branch="main",
        dirty="",
        fetch_code=0,
        ancestor_code=0,
    ):
        self.current = current
        self.target = target
        self.branch = branch
        self.dirty = dirty
        self.fetch_code = fetch_code
        self.ancestor_code = ancestor_code
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, arguments: tuple[str, ...]) -> GitCommandResult:
        self.calls.append(arguments)
        if arguments == ("rev-parse", "--is-inside-work-tree"):
            return GitCommandResult(0, "true")
        if arguments == ("branch", "--show-current"):
            return GitCommandResult(0, self.branch)
        if arguments == ("status", "--porcelain", "--untracked-files=no"):
            return GitCommandResult(0, self.dirty)
        if arguments == ("fetch", "origin", "main"):
            return GitCommandResult(self.fetch_code, "")
        if arguments == ("rev-parse", "HEAD"):
            return GitCommandResult(0, self.current)
        if arguments == ("rev-parse", "origin/main"):
            return GitCommandResult(0, self.target)
        if arguments == ("merge-base", "--is-ancestor", self.current, self.target):
            return GitCommandResult(self.ancestor_code, "")
        return GitCommandResult(2, "")


def make_service(tmp_path: Path, fake_git, *, owner_alive=None) -> PanelUpdateService:
    return PanelUpdateService(
        repo_root=tmp_path / "repo",
        command_path=tmp_path / "runtime" / "runtime-command.json",
        capability_apply_state_path=tmp_path / "runtime" / "capability-apply-state.json",
        git_runner=fake_git,
        update_owner_alive=owner_alive,
    )


def make_policy(tmp_path: Path, profile: str) -> AccessPolicyStore:
    policy_path = tmp_path / f"access-{profile}.json"
    policy_path.parent.mkdir(parents=True, exist_ok=True)
    policy_path.write_text(
        json.dumps({"schemaVersion": 1, "revision": 1, "baseProfile": profile}),
        encoding="utf-8",
    )
    return AccessPolicyStore(policy_path)


def make_client(
    monkeypatch,
    tmp_path: Path,
    fake_git,
    profile="full",
    *,
    update_enabled=True,
    owner_alive=None,
) -> tuple[TestClient, PanelUpdateService]:
    monkeypatch.setenv("PANEL_KIOSK_CONTROLS_ENABLED", "true")
    monkeypatch.setenv(
        "PANEL_UPDATE_CONTROLS_ENABLED",
        "true" if update_enabled else "false",
    )
    service = make_service(tmp_path, fake_git, owner_alive=owner_alive)
    app = FastAPI()
    app.include_router(build_system_update_router(make_policy(tmp_path, profile), service))
    return TestClient(app), service


def write_update_lock(path: Path, *, updated_at: str, owner_pid=None, request_id=REQUEST) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "status": "updating",
        "requestId": request_id,
        "expectedCurrentHead": CURRENT,
        "expectedTargetHead": TARGET,
        "updatedAt": updated_at,
    }
    if owner_pid is not None:
        payload["ownerPid"] = owner_pid
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_update_check_uses_only_canonical_main_and_allows_fast_forward(monkeypatch, tmp_path):
    fake = FakeGit()
    client, _ = make_client(monkeypatch, tmp_path, fake)
    response = client.post(
        "/api/v1/system/update/check",
        headers={"x-panel-intent": "panel-update"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "schemaVersion": "panel-update.v1",
        "currentHead": CURRENT,
        "targetHead": TARGET,
        "updateAvailable": True,
        "updateAllowed": True,
        "status": "update_available",
        "reason": None,
    }
    assert ("fetch", "origin", "main") in fake.calls
    assert ("rev-parse", "HEAD") in fake.calls
    assert ("rev-parse", "origin/main") in fake.calls
    assert all(
        "shell" not in part and "command" not in part
        for call in fake.calls
        for part in call
    )


@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"branch": "feature"}, "wrong_branch"),
        ({"dirty": " M apps/dashboard/src/App.tsx"}, "dirty_checkout"),
        ({"fetch_code": 1}, "fetch_failed"),
        ({"ancestor_code": 1}, "diverged"),
    ],
)
def test_update_check_blocks_invalid_checkout_states(monkeypatch, tmp_path, kwargs, reason):
    client, _ = make_client(monkeypatch, tmp_path, FakeGit(**kwargs))
    response = client.post(
        "/api/v1/system/update/check",
        headers={"x-panel-intent": "panel-update"},
    )
    assert response.status_code == 200
    assert response.json()["updateAllowed"] is False
    assert response.json()["reason"] == reason
    assert "stderr" not in response.text
    assert "environment" not in response.text


def test_same_sha_reports_latest_version(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(target=CURRENT))
    service.dashboard_dist.mkdir(parents=True, exist_ok=True)
    service.dashboard_dist.joinpath("dashboard-build.json").write_text(
        json.dumps({
            "schemaVersion": "dashboard-build.v1",
            "revision": CURRENT,
            "profile": "accepted-v2",
            "buildId": f"{CURRENT}:accepted-v2",
        }),
        encoding="utf-8",
    )
    response = client.post(
        "/api/v1/system/update/check",
        headers={"x-panel-intent": "panel-update"},
    )
    assert response.json()["status"] == "up_to_date"
    assert response.json()["updateAvailable"] is False
    assert response.json()["updateAllowed"] is False


def test_same_sha_with_missing_or_stale_artifact_requires_repair(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(target=CURRENT))
    checked = client.post(
        "/api/v1/system/update/check",
        headers={"x-panel-intent": "panel-update"},
    )
    assert checked.status_code == 200
    assert checked.json() == {
        "schemaVersion": "panel-update.v1",
        "currentHead": CURRENT,
        "targetHead": CURRENT,
        "updateAvailable": True,
        "updateAllowed": True,
        "status": "repair_required",
        "reason": "production_artifact_mismatch",
    }

    applied = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": CURRENT},
    )
    assert applied.status_code == 202
    command = json.loads(service.command_path.read_text(encoding="utf-8"))
    assert command["repair"] is True


def test_same_sha_with_corrupt_artifact_marker_requires_repair_not_success(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(target=CURRENT))
    service.dashboard_dist.mkdir(parents=True, exist_ok=True)
    service.dashboard_dist.joinpath("dashboard-build.json").write_text("not-json", encoding="utf-8")
    response = client.post(
        "/api/v1/system/update/check",
        headers={"x-panel-intent": "panel-update"},
    )
    assert response.json()["status"] == "repair_required"
    assert response.json()["updateAllowed"] is True


def test_update_uses_dedicated_gate_not_kiosk_control_permission(monkeypatch, tmp_path):
    client, service = make_client(
        monkeypatch,
        tmp_path,
        FakeGit(),
        update_enabled=False,
    )
    response = client.post(
        "/api/v1/system/update/check",
        headers={"x-panel-intent": "panel-update"},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "panel_update_disabled"
    assert not service.command_path.exists()


def test_apply_requires_full_access_and_exact_narrow_payload(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(), profile="standard")
    denied = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert denied.status_code == 403
    assert denied.json()["detail"] == "full_access_required"
    assert not service.command_path.exists()

    full_client, full_service = make_client(
        monkeypatch,
        tmp_path / "full",
        FakeGit(),
        profile="full",
    )
    arbitrary = full_client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={
            "expectedCurrentHead": CURRENT,
            "expectedTargetHead": TARGET,
            "command": "git reset --hard",
            "path": "C:/other",
            "branch": "evil",
        },
    )
    assert arbitrary.status_code == 422
    assert not full_service.command_path.exists()


def test_apply_writes_only_fixed_update_command_and_holds_handoff_lock(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(), profile="full")
    response = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert response.status_code == 202
    assert response.json() == {"accepted": True, "status": "updating"}
    command = json.loads(service.command_path.read_text(encoding="utf-8"))
    assert set(command) == {
        "schemaVersion",
        "action",
        "expectedCurrentHead",
        "expectedTargetHead",
        "requestId",
        "requestedAt",
    }
    assert command["action"] == "update_panel"
    assert command["expectedCurrentHead"] == CURRENT
    assert command["expectedTargetHead"] == TARGET
    lock = json.loads(service.lock_path.read_text(encoding="utf-8"))
    assert lock["requestId"] == command["requestId"]
    assert "ownerPid" not in lock
    assert "shell" not in json.dumps(command).lower()
    assert "path" not in command
    assert "branch" not in command


def test_changed_target_is_rejected_before_runtime_command(monkeypatch, tmp_path):
    fake = FakeGit()
    client, service = make_client(monkeypatch, tmp_path, fake, profile="full")
    checked = client.post(
        "/api/v1/system/update/check",
        headers={"x-panel-intent": "panel-update"},
    ).json()
    assert checked["targetHead"] == TARGET
    fake.target = CHANGED_TARGET

    response = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "update_target_changed"
    assert not service.command_path.exists()
    assert not service.lock_path.exists()


def test_live_owner_pid_is_authoritative_even_with_old_heartbeat(tmp_path):
    runtime_root = tmp_path / "runtime"
    now = datetime(2026, 8, 26, 14, 0, tzinfo=timezone.utc)
    write_update_lock(
        runtime_root / "update-lock.json",
        updated_at=(now - timedelta(hours=4)).isoformat(),
        owner_pid=4242,
    )
    assert software_update_active(
        runtime_root,
        now=now,
        owner_alive=lambda pid, request_id: pid == 4242 and request_id == REQUEST,
    )


def test_dead_owner_pid_is_recoverable_immediately(tmp_path):
    runtime_root = tmp_path / "runtime"
    now = datetime(2026, 8, 26, 14, 0, tzinfo=timezone.utc)
    write_update_lock(
        runtime_root / "update-lock.json",
        updated_at=now.isoformat(),
        owner_pid=4242,
    )
    assert not software_update_active(
        runtime_root,
        now=now,
        owner_alive=lambda _pid, _request_id: False,
    )


def test_pre_owner_handoff_is_short_bounded_and_future_timestamp_is_stale(tmp_path):
    runtime_root = tmp_path / "runtime"
    lock_path = runtime_root / "update-lock.json"
    now = datetime(2026, 8, 26, 14, 0, tzinfo=timezone.utc)

    write_update_lock(lock_path, updated_at=(now - timedelta(minutes=1)).isoformat())
    assert software_update_active(runtime_root, now=now)

    write_update_lock(lock_path, updated_at=(now - timedelta(minutes=3)).isoformat())
    assert not software_update_active(runtime_root, now=now)

    write_update_lock(lock_path, updated_at=(now + timedelta(days=1)).isoformat())
    assert not software_update_active(runtime_root, now=now)


def test_future_capability_apply_state_is_not_active(tmp_path):
    state_path = tmp_path / "capability-apply-state.json"
    state_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "building",
            "updatedAt": "2999-01-01T00:00:00+00:00",
        }),
        encoding="utf-8",
    )
    assert not capability_apply_active(state_path)


def test_concurrent_update_and_capability_apply_are_rejected(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(), profile="full")
    service.runtime_root.mkdir(parents=True, exist_ok=True)
    write_update_lock(
        service.lock_path,
        updated_at=datetime.now(timezone.utc).isoformat(),
    )
    second = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert second.status_code == 409
    assert second.json()["detail"] == "update_in_progress"

    service.lock_path.unlink()
    service.capability_apply_state_path.parent.mkdir(parents=True, exist_ok=True)
    service.capability_apply_state_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "building",
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }),
        encoding="utf-8",
    )
    blocked = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "capability_apply_active"
    assert not service.command_path.exists()


def test_future_or_abandoned_handoff_lock_is_recovered_before_new_apply(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(), profile="full")
    write_update_lock(service.lock_path, updated_at="2999-01-01T00:00:00+00:00")

    response = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert response.status_code == 202
    replacement = json.loads(service.lock_path.read_text(encoding="utf-8"))
    assert replacement["requestId"] != REQUEST
    assert "ownerPid" not in replacement


def test_apply_service_rejects_exact_target_change_without_releasing_to_another_writer(tmp_path):
    fake = FakeGit(target=CHANGED_TARGET)
    service = make_service(tmp_path, fake)
    with pytest.raises(HTTPException) as exc:
        service.apply(CURRENT, TARGET)
    assert exc.value.status_code == 409
    assert exc.value.detail == "update_target_changed"
    assert not service.command_path.exists()
    assert not service.lock_path.exists()


def test_check_failure_returns_fixed_safe_error_without_exception_or_environment(monkeypatch, tmp_path):
    def failing_git(_arguments):
        raise RuntimeError("SECRET_TOKEN=C:/private/repo fatal: credential leaked")

    client, service = make_client(monkeypatch, tmp_path, failing_git)
    response = client.post(
        "/api/v1/system/update/check",
        headers={"x-panel-intent": "panel-update"},
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "update_check_failed"}
    assert "SECRET_TOKEN" not in response.text
    assert "private" not in response.text
    assert service.owner_state()["status"] == "idle"


def test_owner_status_whitelists_result_and_never_exposes_local_fields(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit())
    service.runtime_root.mkdir(parents=True, exist_ok=True)
    service.state_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "failed",
            "updatedAt": "2026-08-26T00:00:00+00:00",
            "result": "SECRET=C:/owner/repo",
            "stderr": "fatal: private data",
            "environment": {"TOKEN": "secret"},
        }),
        encoding="utf-8",
    )
    response = client.get("/api/v1/system/update/status")
    assert response.status_code == 200
    assert response.json() == {
        "schemaVersion": 1,
        "status": "failed",
        "updatedAt": "2026-08-26T00:00:00+00:00",
    }
    serialized = response.text
    assert "SECRET" not in serialized
    assert "stderr" not in serialized
    assert "environment" not in serialized


def test_apply_persists_bounded_transaction_identity_for_reload(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(), profile="full")
    response = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert response.status_code == 202

    recovered = make_service(tmp_path, FakeGit())
    state = recovered.owner_state()
    assert state["status"] == "updating"
    assert state["currentHead"] == CURRENT
    assert state["targetHead"] == TARGET
    assert len(state["requestId"]) == 24
    assert all(character in "0123456789abcdef" for character in state["requestId"])
    assert "ownerPid" not in json.dumps(state)

    duplicate = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "update_in_progress"


def test_update_check_does_not_overwrite_active_transaction(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(), profile="full")
    applied = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert applied.status_code == 202
    before = json.loads(service.state_path.read_text(encoding="utf-8"))

    checked = client.post(
        "/api/v1/system/update/check",
        headers={"x-panel-intent": "panel-update"},
    )
    assert checked.status_code == 200
    assert checked.json()["reason"] == "update_in_progress"
    after = json.loads(service.state_path.read_text(encoding="utf-8"))
    assert after == before


def test_status_uses_server_owned_dead_owner_evidence(monkeypatch, tmp_path):
    client, service = make_client(
        monkeypatch,
        tmp_path,
        FakeGit(),
        profile="full",
        owner_alive=lambda _pid, _request_id: False,
    )
    service.runtime_root.mkdir(parents=True, exist_ok=True)
    service.state_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "updating",
            "requestId": REQUEST,
            "currentHead": CURRENT,
            "targetHead": TARGET,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }),
        encoding="utf-8",
    )
    write_update_lock(
        service.lock_path,
        updated_at=datetime.now(timezone.utc).isoformat(),
        owner_pid=4242,
    )

    response = client.get("/api/v1/system/update/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["schemaVersion"] == 1
    assert payload["status"] == "failed"
    assert payload["requestId"] == REQUEST
    assert payload["currentHead"] == CURRENT
    assert payload["targetHead"] == TARGET
    assert payload["result"] == "updater_stale"


def test_terminal_state_retains_target_and_served_revision_but_not_arbitrary_fields(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit())
    service.runtime_root.mkdir(parents=True, exist_ok=True)
    service.state_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "success",
            "requestId": REQUEST,
            "currentHead": CURRENT,
            "targetHead": TARGET,
            "servedRevision": TARGET,
            "updatedAt": "2026-08-26T00:00:00+00:00",
            "result": "updated",
            "ownerPid": 4242,
            "command": "powershell.exe -File update-production.ps1",
        }),
        encoding="utf-8",
    )

    response = client.get("/api/v1/system/update/status")
    assert response.status_code == 200
    assert response.json() == {
        "schemaVersion": 1,
        "status": "success",
        "updatedAt": "2026-08-26T00:00:00+00:00",
        "requestId": REQUEST,
        "currentHead": CURRENT,
        "targetHead": TARGET,
        "servedRevision": TARGET,
        "result": "updated",
    }
    assert "ownerPid" not in response.text
    assert "command" not in response.text


def test_terminal_rollback_failure_is_not_reclassified_as_stale(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit())
    service.runtime_root.mkdir(parents=True, exist_ok=True)
    service.state_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "failed",
            "requestId": REQUEST,
            "currentHead": CURRENT,
            "targetHead": TARGET,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "result": "rollback_failed",
        }),
        encoding="utf-8",
    )
    service.runtime_root.joinpath("update-transaction.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "incomplete",
            "phase": "rollback",
            "previousHead": CURRENT,
            "targetHead": TARGET,
            "requestId": REQUEST,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }),
        encoding="utf-8",
    )

    payload = client.get("/api/v1/system/update/status").json()
    assert payload["status"] == "failed"
    assert payload["result"] == "rollback_failed"
    assert payload["phase"] == "rollback"


def test_terminal_success_wins_during_updater_lock_cleanup(monkeypatch, tmp_path):
    client, service = make_client(
        monkeypatch,
        tmp_path,
        FakeGit(),
        owner_alive=lambda _pid, _request_id: True,
    )
    service.runtime_root.mkdir(parents=True, exist_ok=True)
    service.state_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "success",
            "requestId": REQUEST,
            "currentHead": CURRENT,
            "targetHead": TARGET,
            "servedRevision": TARGET,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "result": "updated",
        }),
        encoding="utf-8",
    )
    write_update_lock(
        service.lock_path,
        updated_at=datetime.now(timezone.utc).isoformat(),
        owner_pid=4242,
    )

    payload = client.get("/api/v1/system/update/status").json()
    assert payload["status"] == "success"
    assert payload["result"] == "updated"
