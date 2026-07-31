from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.avalar_actions import AvalarActionExecutor, AvalarActionRequest
from panel_agent.settings import IntegrationSettings


class FakeDetails:
    def __init__(self) -> None:
        self.values = {
            "avalar-site-main": {
                "environment": "production",
                "commit": "a" * 40,
                "deployment_revision": "a" * 40,
            },
            "avalar-site-stage": {
                "environment": "stage",
                "commit": "b" * 40,
                "deployment_revision": "b" * 40,
            },
        }

    async def refresh(self) -> None:
        return None

    def details_for(self, service_id: str):
        return dict(self.values.get(service_id, {}))


def settings() -> IntegrationSettings:
    return IntegrationSettings(
        avalar_main_url="https://avalar.example",
        avalar_stage_url="https://stage.avalar.example",
        writes_enabled=True,
        avalar_actions_enabled=True,
        avalar_smoke_enabled=True,
        avalar_stage_restart_enabled=True,
        avalar_main_restart_enabled=True,
        avalar_stage_deploy_enabled=True,
        avalar_main_deploy_enabled=False,
        avalar_action_ssh_host="avalar-control",
        avalar_action_remote_script="~/control-center-avalar-action.sh",
    )


@pytest.mark.asyncio
async def test_full_only_action_requires_elevation_and_keeps_environments_separate(tmp_path):
    access = AccessPolicyStore(tmp_path / "policy.json")
    access.set_pin("2468")
    access.set_profile("standard")
    details = FakeDetails()
    operations: list[str] = []

    async def command_runner(operation: str):
        operations.append(operation)
        environment = "production" if operation.endswith("main") else "stage"
        return {
            "ok": True,
            "operation": operation,
            "environment": environment,
            "status": "verified",
            "checks": ["health/live", "health/ready", "root"],
        }

    executor = AvalarActionExecutor(
        settings(),
        access,
        details_provider=details,
        command_runner=command_runner,
    )

    async def healthy(_: str) -> None:
        return None

    executor._verify_public_health = healthy  # type: ignore[method-assign]

    with pytest.raises(HTTPException) as rejected:
        await executor.start(
            AvalarActionRequest(
                actionId="avalar.stage.restart",
                expectedRevision="b" * 40,
            )
        )
    assert rejected.value.detail == "elevation_required"

    access.unlock_temporary("2468")
    execution = await executor.start(
        AvalarActionRequest(
            actionId="avalar.stage.restart",
            expectedRevision="b" * 40,
        )
    )
    for _ in range(50):
        current = executor.get(execution.correlationId)
        if current.status in {"success", "failed"}:
            break
        await asyncio.sleep(0.01)

    assert current.status == "success"
    assert operations == ["restart-stage"]
    assert current.environment == "stage"
    assert current.result["revisionBefore"] == "b" * 40
    assert current.result["revisionAfter"] == "b" * 40


@pytest.mark.asyncio
async def test_main_restart_needs_strong_confirmation_and_main_deploy_gate(tmp_path):
    access = AccessPolicyStore(tmp_path / "policy.json")
    access.set_pin("1357")
    access.set_profile("full", pin="1357")
    executor = AvalarActionExecutor(
        settings(),
        access,
        details_provider=FakeDetails(),
        command_runner=lambda _: None,  # type: ignore[arg-type]
    )

    with pytest.raises(HTTPException) as confirmation:
        await executor.start(
            AvalarActionRequest(
                actionId="avalar.main.restart",
                expectedRevision="a" * 40,
            )
        )
    assert confirmation.value.detail == "main_restart_confirmation_required"

    assert executor.availability("avalar.main.deploy")["availability"] == "gate_disabled"
    with pytest.raises(HTTPException) as deploy:
        await executor.start(
            AvalarActionRequest(
                actionId="avalar.main.deploy",
                expectedRevision="a" * 40,
                confirmation="DEPLOY MAIN",
            )
        )
    assert deploy.value.detail == "gate_disabled"
