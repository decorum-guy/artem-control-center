from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.system_update import (
    GitCommandResult,
    PanelUpdateService,
    build_system_update_router,
)

CURRENT = "a" * 40
TARGET = "b" * 40
CHANGED_TARGET = "c" * 40


class FakeGit:
    def __init__(self, *, current=CURRENT, target=TARGET, branch="main", dirty="", fetch_code=0, ancestor_code=0):
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


def make_service(tmp_path: Path, fake_git: FakeGit) -> PanelUpdateService:
    return PanelUpdateService(
        repo_root=tmp_path / "repo",
        command_path=tmp_path / "runtime" / "runtime-command.json",
        capability_apply_state_path=tmp_path / "runtime" / "capability-apply-state.json",
        git_runner=fake_git,
    )


def make_policy(tmp_path: Path, profile: str) -> AccessPolicyStore:
    policy_path = tmp_path / f"access-{profile}.json"
    policy_path.parent.mkdir(parents=True, exist_ok=True)
    policy_path.write_text(
        json.dumps({"schemaVersion": 1, "revision": 1, "baseProfile": profile}),
        encoding="utf-8",
    )
    return AccessPolicyStore(policy_path)


def make_client(monkeypatch, tmp_path: Path, fake_git: FakeGit, profile="full") -> tuple[TestClient, PanelUpdateService]:
    monkeypatch.setenv("PANEL_KIOSK_CONTROLS_ENABLED", "true")
    service = make_service(tmp_path, fake_git)
    app = FastAPI()
    app.include_router(build_system_update_router(make_policy(tmp_path, profile), service))
    return TestClient(app), service


def test_update_check_uses_only_canonical_main_and_allows_fast_forward(monkeypatch, tmp_path):
    fake = FakeGit()
    client, _ = make_client(monkeypatch, tmp_path, fake)
    response = client.post("/api/v1/system/update/check", headers={"x-panel-intent": "panel-update"})

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
    assert all("shell" not in part and "command" not in part for call in fake.calls for part in call)


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
    response = client.post("/api/v1/system/update/check", headers={"x-panel-intent": "panel-update"})
    assert response.status_code == 200
    assert response.json()["updateAllowed"] is False
    assert response.json()["reason"] == reason
    assert "stderr" not in response.text
    assert "environment" not in response.text


def test_same_sha_reports_latest_version(monkeypatch, tmp_path):
    client, _ = make_client(monkeypatch, tmp_path, FakeGit(target=CURRENT))
    response = client.post("/api/v1/system/update/check", headers={"x-panel-intent": "panel-update"})
    assert response.json()["status"] == "up_to_date"
    assert response.json()["updateAvailable"] is False
    assert response.json()["updateAllowed"] is False


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

    full_client, full_service = make_client(monkeypatch, tmp_path / "full", FakeGit(), profile="full")
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


def test_apply_writes_only_fixed_update_command_and_holds_lock(monkeypatch, tmp_path):
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
        "schemaVersion", "action", "expectedCurrentHead", "expectedTargetHead", "requestId", "requestedAt"
    }
    assert command["action"] == "update_panel"
    assert command["expectedCurrentHead"] == CURRENT
    assert command["expectedTargetHead"] == TARGET
    lock = json.loads(service.lock_path.read_text(encoding="utf-8"))
    assert lock["requestId"] == command["requestId"]
    assert "shell" not in json.dumps(command).lower()
    assert "path" not in command
    assert "branch" not in command


def test_changed_target_is_rejected_before_runtime_command(monkeypatch, tmp_path):
    fake = FakeGit()
    client, service = make_client(monkeypatch, tmp_path, fake, profile="full")
    checked = client.post("/api/v1/system/update/check", headers={"x-panel-intent": "panel-update"}).json()
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


def test_concurrent_update_and_capability_apply_are_rejected(monkeypatch, tmp_path):
    client, service = make_client(monkeypatch, tmp_path, FakeGit(), profile="full")
    service.runtime_root.mkdir(parents=True, exist_ok=True)
    service.lock_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "updating",
            "requestId": "0" * 24,
            "updatedAt": "2999-01-01T00:00:00+00:00",
        }),
        encoding="utf-8",
    )
    second = client.post(
        "/api/v1/system/update/apply",
        headers={"x-panel-intent": "panel-update"},
        json={"expectedCurrentHead": CURRENT, "expectedTargetHead": TARGET},
    )
    assert second.status_code == 409
    assert second.json()["detail"] == "update_in_progress"

    service.lock_path.unlink()
    service.capability_apply_state_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "status": "building",
            "updatedAt": "2999-01-01T00:00:00+00:00",
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


def test_apply_service_rejects_exact_target_change_without_releasing_to_another_writer(tmp_path):
    fake = FakeGit(target=CHANGED_TARGET)
    service = make_service(tmp_path, fake)
    with pytest.raises(HTTPException) as exc:
        service.apply(CURRENT, TARGET)
    assert exc.value.status_code == 409
    assert exc.value.detail == "update_target_changed"
    assert not service.command_path.exists()
    assert not service.lock_path.exists()
