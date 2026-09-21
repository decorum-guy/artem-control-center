from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.system_controls import (
    SystemControlsError,
    WindowsSystemControls,
    build_system_controls_router,
)


class Result:
    def __init__(self, payload: dict, returncode: int = 0) -> None:
        self.stdout = json.dumps(payload)
        self.stderr = ""
        self.returncode = returncode


class FakePowerShell:
    def __init__(self, *, brightness_available: bool = True) -> None:
        self.calls: list[list[str]] = []
        self.volume = 37
        self.brightness = 62
        self.brightness_available = brightness_available

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        action = argv[argv.index("-Action") + 1]
        if action == "set-volume":
            self.volume = int(argv[argv.index("-Value") + 1])
        elif action == "set-brightness":
            self.brightness = int(argv[argv.index("-Value") + 1])
        return Result(
            {
                "schemaVersion": 1,
                "volume": {"available": True, "value": self.volume, "reason": None},
                "brightness": {
                    "available": self.brightness_available,
                    "value": self.brightness if self.brightness_available else None,
                    "reason": None if self.brightness_available else "unsupported",
                },
            }
        )


def make_controls(tmp_path: Path, runner: FakePowerShell) -> WindowsSystemControls:
    script = tmp_path / "system-controls.ps1"
    script.write_text("# fixed helper", encoding="utf-8")
    return WindowsSystemControls(
        platform="nt",
        powershell="powershell.exe",
        script_path=script,
        runner=runner,
    )


def make_client(tmp_path: Path, controls: WindowsSystemControls, *, profile: str = "standard", writes: bool = True):
    access = AccessPolicyStore(tmp_path / "access-policy.json")
    access.set_profile(profile)
    app = FastAPI()
    app.include_router(
        build_system_controls_router(
            controls,
            access,
            writes_enabled=lambda: writes,
        )
    )
    return TestClient(app), access


def test_fixed_powershell_argv_and_readback(tmp_path):
    runner = FakePowerShell()
    controls = make_controls(tmp_path, runner)

    status = controls.read()
    assert status["volume"] == {"available": True, "value": 37, "reason": None}
    assert status["brightness"] == {"available": True, "value": 62, "reason": None}

    changed = controls.set_value("volume", 71)
    assert changed["value"] == 71

    argv = runner.calls[-1]
    assert argv[:7] == [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]
    assert argv[-4:] == ["-Action", "set-volume", "-Value", "71"]
    assert all(";" not in part for part in argv[-4:])


def test_unsupported_platform_never_runs_subprocess(tmp_path):
    runner = FakePowerShell()
    controls = WindowsSystemControls(
        platform="posix",
        script_path=tmp_path / "missing.ps1",
        runner=runner,
    )

    status = controls.read()
    assert status["volume"]["available"] is False
    assert status["volume"]["reason"] == "unsupported"
    assert status["brightness"]["available"] is False
    assert runner.calls == []

    with pytest.raises(SystemControlsError, match="system_controls_unavailable"):
        controls.set_value("volume", 50)


def test_bounds_are_enforced_before_helper_execution(tmp_path):
    runner = FakePowerShell()
    controls = make_controls(tmp_path, runner)

    with pytest.raises(ValueError, match="out_of_range"):
        controls.set_value("brightness", 101)
    with pytest.raises(ValueError, match="out_of_range"):
        controls.set_value("volume", -1)
    assert runner.calls == []


def test_status_is_readable_but_read_only_profile_cannot_write(tmp_path):
    runner = FakePowerShell()
    controls = make_controls(tmp_path, runner)
    client, _ = make_client(tmp_path, controls, profile="read_only")

    response = client.get("/api/v1/settings/system-controls")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["controls"]["volume"]["value"] == 37
    assert response.json()["controls"]["volume"]["writable"] is False
    assert response.json()["controls"]["volume"]["writeAvailability"] == "profile_blocked"

    rejected = client.patch("/api/v1/settings/system-controls/volume", json={"value": 55})
    assert rejected.status_code == 403
    assert runner.volume == 37


def test_standard_profile_writes_and_returns_effective_readback(tmp_path):
    runner = FakePowerShell()
    controls = make_controls(tmp_path, runner)
    client, _ = make_client(tmp_path, controls)

    changed = client.patch("/api/v1/settings/system-controls/volume", json={"value": 55})
    assert changed.status_code == 200
    assert changed.headers["cache-control"] == "no-store"
    assert changed.json()["controls"]["volume"]["value"] == 55
    assert changed.json()["controls"]["volume"]["writable"] is True

    brightness = client.patch("/api/v1/settings/system-controls/brightness", json={"value": 28})
    assert brightness.status_code == 200
    assert brightness.json()["controls"]["brightness"]["value"] == 28


def test_unavailable_brightness_fails_closed_without_set_call(tmp_path):
    runner = FakePowerShell(brightness_available=False)
    controls = make_controls(tmp_path, runner)
    client, _ = make_client(tmp_path, controls)

    before = len(runner.calls)
    response = client.patch("/api/v1/settings/system-controls/brightness", json={"value": 50})
    assert response.status_code == 503
    assert response.json()["detail"] == "integration_unavailable"
    assert len(runner.calls) == before + 1
    assert runner.calls[-1][runner.calls[-1].index("-Action") + 1] == "status"


def test_write_gate_and_request_schema_fail_closed(tmp_path):
    runner = FakePowerShell()
    controls = make_controls(tmp_path, runner)
    client, _ = make_client(tmp_path, controls, writes=False)

    gated = client.patch("/api/v1/settings/system-controls/volume", json={"value": 42})
    assert gated.status_code == 409
    assert gated.json()["detail"] == "gate_disabled"

    over = client.patch("/api/v1/settings/system-controls/volume", json={"value": 101})
    assert over.status_code == 422

    injected = client.patch(
        "/api/v1/settings/system-controls/volume",
        json={"value": 42, "command": "whoami"},
    )
    assert injected.status_code == 422
