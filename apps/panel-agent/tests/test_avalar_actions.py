from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.avalar_actions import AvalarActionExecution, AvalarActionExecutor, AvalarActionRequest
from panel_agent.integrations import IntegrationRuntime
from panel_agent.project_registry import ProjectRegistry
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
        avalar_action_remote_script="control-center",
    )


def test_full_only_action_requires_elevation_and_keeps_environments_separate(tmp_path):
    async def scenario() -> None:
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
        current = executor.get(execution.correlationId)
        for _ in range(50):
            current = executor.get(execution.correlationId)
            if current.status in {"success", "failed"}:
                break
            await asyncio.sleep(0.01)

        assert current.status == "success"
        assert operations == ["restart-stage"]
        assert current.environment == "stage"
        assert current.result is not None
        assert current.result["revisionBefore"] == "b" * 40
        assert current.result["revisionAfter"] == "b" * 40

    asyncio.run(scenario())


def test_main_restart_confirmation_is_required_for_temporary_full_but_waived_for_manual_full(tmp_path):
    async def scenario() -> None:
        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_pin("1357")
        access.set_profile("standard")

        async def command_runner(operation: str):
            return {
                "ok": True,
                "operation": operation,
                "environment": "production",
                "status": "verified",
            }

        executor = AvalarActionExecutor(
            settings(),
            access,
            details_provider=FakeDetails(),
            command_runner=command_runner,
        )

        async def healthy(_: str) -> None:
            return None

        executor._verify_public_health = healthy  # type: ignore[method-assign]

        with pytest.raises(HTTPException) as elevation:
            await executor.start(
                AvalarActionRequest(
                    actionId="avalar.main.restart",
                    expectedRevision="a" * 40,
                )
            )
        assert elevation.value.detail == "elevation_required"

        access.unlock_temporary("1357")
        with pytest.raises(HTTPException) as confirmation:
            await executor.start(
                AvalarActionRequest(
                    actionId="avalar.main.restart",
                    expectedRevision="a" * 40,
                )
            )
        assert confirmation.value.detail == "main_restart_confirmation_required"

        access.set_profile("full", pin="1357")
        execution = await executor.start(
            AvalarActionRequest(
                actionId="avalar.main.restart",
                expectedRevision="a" * 40,
            )
        )
        assert execution.actionId == "avalar.main.restart"
        for _ in range(50):
            current = executor.get(execution.correlationId)
            if current.status in {"success", "failed"}:
                break
            await asyncio.sleep(0.01)
        assert current.status == "success"

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

    asyncio.run(scenario())


def test_successful_action_refreshes_registry_backed_avalar_services(tmp_path):
    async def scenario() -> None:
        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_pin("2468")
        access.set_profile("full", pin="2468")
        runtime = IntegrationRuntime(
            settings(),
            project_registry=ProjectRegistry.empty(Path(tmp_path / "projects.yaml")),
        )
        refreshed: list[tuple[str, ...]] = []

        async def refresh(service_ids=None):
            refreshed.append(tuple(service_ids or ()))
            return True

        runtime.project_monitor.refresh = refresh  # type: ignore[method-assign]

        async def command_runner(operation: str):
            return {
                "ok": True,
                "operation": operation,
                "environment": "production",
                "status": "verified",
            }

        executor = AvalarActionExecutor(
            settings(),
            access,
            details_provider=FakeDetails(),
            refresh_callback=runtime.refresh_avalar,
            command_runner=command_runner,
        )

        async def healthy(_: str) -> None:
            return None

        executor._verify_public_health = healthy  # type: ignore[method-assign]
        try:
            execution = await executor.start(
                AvalarActionRequest(
                    actionId="avalar.main.smoke",
                    expectedRevision="a" * 40,
                )
            )
            for _ in range(50):
                current = executor.get(execution.correlationId)
                if current.status in {"success", "failed"}:
                    break
                await asyncio.sleep(0.01)
            assert current.status == "success"
            assert refreshed == [("avalar.main.website", "avalar.stage.website")]
        finally:
            await runtime.close()

    asyncio.run(scenario())


def test_stage_deploy_requires_new_verified_backup_matching_revision(tmp_path):
    async def scenario() -> None:
        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_pin("2468")
        access.set_profile("full", pin="2468")
        events: list[str] = []

        class Backup:
            def available(self, profile_id: str) -> bool:
                return profile_id == "avalar-stage-site"
            def run_sync(self, profile_id: str) -> dict:
                events.append("backup")
                return {"backupId": "b1", "result": "success", "verificationStatus": "verified", "sourceCommit": "b" * 40, "sha256": "c" * 64}

        async def runner(operation: str) -> dict:
            events.append(operation)
            return {"ok": True, "operation": operation, "environment": "stage", "status": "verified"}

        executor = AvalarActionExecutor(settings(), access, details_provider=FakeDetails(), command_runner=runner, backup_service=Backup())
        async def healthy(_: str) -> None: return None
        executor._verify_public_health = healthy  # type: ignore[method-assign]
        accepted = await executor.start(AvalarActionRequest(actionId="avalar.stage.deploy", expectedRevision="b" * 40))
        for _ in range(50):
            current = executor.get(accepted.correlationId)
            if current.status in {"success", "failed"}: break
            await asyncio.sleep(0.01)
        assert current.status == "success"
        assert events == ["backup", "deploy-stage"]
        assert current.result and current.result["backupSourceCommit"] == "b" * 40

    asyncio.run(scenario())


def test_stage_deploy_never_runs_command_after_backup_revision_mismatch(tmp_path):
    async def scenario() -> None:
        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_pin("2468")
        access.set_profile("full", pin="2468")
        calls: list[str] = []
        class Backup:
            def available(self, _: str) -> bool: return True
            def run_sync(self, _: str) -> dict: return {"result": "success", "verificationStatus": "verified", "sourceCommit": "a" * 40}
        async def runner(operation: str) -> dict:
            calls.append(operation); return {"environment": "stage"}
        executor = AvalarActionExecutor(settings(), access, details_provider=FakeDetails(), command_runner=runner, backup_service=Backup())
        accepted = await executor.start(AvalarActionRequest(actionId="avalar.stage.deploy", expectedRevision="b" * 40))
        for _ in range(50):
            current = executor.get(accepted.correlationId)
            if current.status in {"success", "failed"}: break
            await asyncio.sleep(0.01)
        assert current.error == "backup_revision_mismatch"
        assert calls == []
    asyncio.run(scenario())


@pytest.mark.parametrize("error", [
    "backup_remote_disabled", "backup_busy", "backup_remote_busy",
    "backup_remote_timeout", "backup_remote_failed", "backup_transport_invalid",
    "backup_verification_failed", "backup_destination_unavailable",
    "backup_insufficient_free_space", "backup_history_unavailable",
    "backup_manifest_failed", "backup_history_write_failed", "backup_failed",
    "backup_revision_mismatch",
])
def test_stage_deploy_never_calls_remote_command_for_any_backup_failure(tmp_path, error: str):
    async def scenario() -> None:
        access = AccessPolicyStore(tmp_path / f"policy-{error}.json")
        access.set_pin("2468"); access.set_profile("full", pin="2468")
        calls: list[str] = []
        class Backup:
            def available(self, _: str) -> bool: return True
            def run_sync(self, _: str) -> dict:
                if error == "backup_revision_mismatch":
                    return {"result": "success", "verificationStatus": "verified", "sourceCommit": "a" * 40}
                return {"result": "failed", "verificationStatus": "failed", "errorCode": error}
        async def command_runner(operation: str) -> dict:
            calls.append(operation); return {"environment": "stage"}
        executor = AvalarActionExecutor(settings(), access, details_provider=FakeDetails(), command_runner=command_runner, backup_service=Backup())
        correlation = "deterministic"
        executor.executions[correlation] = AvalarActionExecution(correlationId=correlation, actionId="avalar.stage.deploy", environment="stage", status="requested", requestedAt="2026-01-01T00:00:00Z", updatedAt="2026-01-01T00:00:00Z")
        executor.active_correlation_id = correlation
        await executor._execute(correlation, "b" * 40)
        assert executor.get(correlation).error == error
        assert calls == []
    asyncio.run(scenario())


def test_only_stage_deploy_calls_backup_and_unavailable_backup_disables_it(tmp_path):
    async def scenario() -> None:
        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_pin("2468"); access.set_profile("full", pin="2468")
        calls: list[str] = []
        class Backup:
            def available(self, _: str) -> bool: return True
            def run_sync(self, _: str) -> dict:
                calls.append("backup")
                return {"result": "success", "verificationStatus": "verified", "sourceCommit": "b" * 40, "backupId": "id", "sha256": "c" * 64}
        async def runner(operation: str) -> dict:
            return {"environment": "stage" if operation.endswith("stage") else "production"}
        async def healthy(_: str) -> None:
            return None
        executor = AvalarActionExecutor(settings(), access, details_provider=FakeDetails(), command_runner=runner, backup_service=Backup())
        for action_id, revision in (("avalar.stage.restart", "b" * 40), ("avalar.stage.smoke", "b" * 40), ("avalar.main.smoke", "a" * 40), ("avalar.main.restart", "a" * 40), ("avalar.main.deploy", "a" * 40)):
            correlation = action_id
            executor.executions[correlation] = AvalarActionExecution(correlationId=correlation, actionId=action_id, environment="stage" if ".stage." in action_id else "production", status="requested", requestedAt="2026-01-01T00:00:00Z", updatedAt="2026-01-01T00:00:00Z")
            executor.active_correlation_id = correlation
            executor._verify_public_health = healthy  # type: ignore[method-assign]
            await executor._execute(correlation, revision)
        assert calls == []
        class Unavailable:
            def available(self, _: str) -> bool: return False
            def run_sync(self, _: str) -> dict: raise AssertionError("must not run")
        unavailable = AvalarActionExecutor(settings(), access, details_provider=FakeDetails(), backup_service=Unavailable())
        assert unavailable.availability("avalar.stage.deploy")["availability"] == "integration_unavailable"
    asyncio.run(scenario())


def test_stage_deploy_revision_conflict_happens_before_backup(tmp_path):
    async def scenario() -> None:
        access = AccessPolicyStore(tmp_path / "policy.json")
        access.set_pin("2468"); access.set_profile("full", pin="2468")
        calls: list[str] = []
        class Backup:
            def available(self, _: str) -> bool: return True
            def run_sync(self, _: str) -> dict:
                calls.append("backup"); return {}
        executor = AvalarActionExecutor(settings(), access, details_provider=FakeDetails(), backup_service=Backup())
        with pytest.raises(HTTPException) as conflict:
            await executor.start(AvalarActionRequest(actionId="avalar.stage.deploy", expectedRevision="a" * 40))
        assert conflict.value.detail == "revision_conflict"
        assert calls == []
    asyncio.run(scenario())
