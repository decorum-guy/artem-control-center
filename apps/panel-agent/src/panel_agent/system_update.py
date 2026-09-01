from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, Header, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .access_policy import AccessPolicyStore

SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
REQUEST_ID_PATTERN = re.compile(r"^[0-9a-f]{24}$")
UPDATE_HANDOFF_MAX_AGE = timedelta(minutes=2)
CAPABILITY_APPLY_MAX_AGE = timedelta(minutes=15)
SAFE_OWNER_RESULTS = frozenset({
    "up_to_date",
    "updated",
    "rollback_restored",
    "rollback_failed",
    "pre_update_failed",
    "invalid_update_command",
    "updater_unavailable",
    "capability_apply_active",
    "update_lock_mismatch",
    "build_failed",
    "artifact_assertion_failed",
    "served_artifact_mismatch",
    "restart_failed",
    "repair_required",
    "target_handoff_lease_rejected",
    "updater_spawn_failed",
    "updater_early_exit",
    "updater_stale",
})
UPDATE_PHASES = frozenset({
    "started",
    "stopping",
    "checkout",
    "handoff",
    "target-authoritative",
    "validating",
    "building",
    "artifact-ready",
    "restarting",
    "verifying",
    "rollback",
})
UPDATE_ACTIVITY_MAX = 32
UPDATE_ACTIVITY_CODES = frozenset((*UPDATE_PHASES, "completed"))
UPDATE_ACTIVITY_COPY = {
    "started": "Проверяем обновление",
    "stopping": "Останавливаем текущую панель",
    "checkout": "Получаем новую версию",
    "handoff": "Передаём управление новой версии обновлятора",
    "target-authoritative": "Получаем новую версию",
    "validating": "Проверяем проект",
    "building": "Собираем панель",
    "artifact-ready": "Готовим новую сборку",
    "restarting": "Перезапускаем Control Center",
    "verifying": "Проверяем запущенную версию",
    "rollback": "Восстанавливаем предыдущую версию",
    "completed": "Обновление завершено",
}
UPDATE_PHASE_PROGRESS = {
    "started": 5,
    "stopping": 12,
    "checkout": 24,
    "handoff": 30,
    "target-authoritative": 36,
    "validating": 50,
    "building": 66,
    "artifact-ready": 76,
    "restarting": 86,
    "verifying": 95,
    # Rollback is deliberately visible as its own phase rather than being
    # presented as forward progress toward a successful update.
    "rollback": 60,
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _utc_now().isoformat()


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _safe_timestamp(value: object) -> str | None:
    parsed = _parse_time(value)
    if parsed is None or parsed > _utc_now():
        return None
    return parsed.isoformat()


def _safe_revision(value: object) -> str | None:
    if not isinstance(value, str) or SHA_PATTERN.fullmatch(value) is None:
        return None
    return value


def _safe_request_id(value: object) -> str | None:
    if not isinstance(value, str) or REQUEST_ID_PATTERN.fullmatch(value) is None:
        return None
    return value


def _safe_activity_events(value: object) -> list[dict[str, str]]:
    """Return only the fixed, owner-safe activity vocabulary."""
    if not isinstance(value, list):
        return []
    events: list[dict[str, str]] = []
    for item in value[-UPDATE_ACTIVITY_MAX:]:
        if not isinstance(item, dict):
            continue
        code = item.get("code")
        if not isinstance(code, str) or code not in UPDATE_ACTIVITY_CODES:
            continue
        if events and events[-1]["code"] == code:
            continue
        events.append({"code": code})
    return events[-UPDATE_ACTIVITY_MAX:]


def _recent_update_transaction(transaction: dict | None) -> bool:
    """Return whether a valid transaction heartbeat is within the handoff grace.

    This is deliberately separate from the updater-process lease. It covers a
    short atomic publication/read gap while still giving the server a bounded,
    owner-controlled stale result when both the process lease and its recent
    transaction heartbeat have disappeared.
    """
    if not transaction:
        return False
    updated = _parse_time(transaction.get("updatedAt"))
    if updated is None:
        return False
    now = _utc_now()
    return updated <= now and now - updated <= UPDATE_HANDOFF_MAX_AGE


def _read_json(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _recent_state(path: Path, statuses: set[str], max_age: timedelta) -> bool:
    payload = _read_json(path)
    if not payload or payload.get("schemaVersion") != 1:
        return False
    if payload.get("status") not in statuses:
        return False
    updated = _parse_time(payload.get("updatedAt"))
    if updated is None:
        return False
    now = _utc_now()
    if updated > now:
        return False
    return now - updated <= max_age


def capability_apply_active(path: Path | None) -> bool:
    return bool(
        path
        and _recent_state(path, {"queued", "building", "restarting"}, CAPABILITY_APPLY_MAX_AGE)
    )


UpdateOwnerAlive = Callable[[int, str], bool]


def _updater_owner_alive(owner_pid: int, request_id: str) -> bool:
    if os.name != "nt" or owner_pid <= 0 or not REQUEST_ID_PATTERN.fullmatch(request_id):
        return False
    script = (
        f'$process = Get-CimInstance Win32_Process -Filter "ProcessId = {owner_pid}" '
        '-ErrorAction SilentlyContinue; '
        'if ($null -ne $process '
        "-and $process.Name -in @('powershell.exe','pwsh.exe') "
        "-and $process.CommandLine -like '*update-production.ps1*' "
        f"-and ($process.CommandLine -notlike '*-RequestId*' -or $process.CommandLine -like '*{request_id}*')) {{ exit 0 }}; exit 1"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _update_lock_active(
    payload: dict | None,
    *,
    now: datetime | None = None,
    owner_alive: UpdateOwnerAlive | None = None,
) -> bool:
    if not payload or payload.get("schemaVersion") != 1 or payload.get("status") != "updating":
        return False
    request_id = payload.get("requestId")
    if not isinstance(request_id, str) or not REQUEST_ID_PATTERN.fullmatch(request_id):
        return False
    updated = _parse_time(payload.get("updatedAt"))
    if updated is None:
        return False

    owner_pid = payload.get("ownerPid")
    if owner_pid is not None:
        if isinstance(owner_pid, bool) or not isinstance(owner_pid, int) or owner_pid <= 0:
            return False
        checker = owner_alive or _updater_owner_alive
        return checker(owner_pid, request_id)

    current = now or _utc_now()
    if updated > current:
        return False
    return current - updated <= UPDATE_HANDOFF_MAX_AGE


def software_update_active(
    runtime_root: Path,
    *,
    now: datetime | None = None,
    owner_alive: UpdateOwnerAlive | None = None,
) -> bool:
    return _update_lock_active(
        _read_json(runtime_root / "update-lock.json"),
        now=now,
        owner_alive=owner_alive,
    )


def _bool_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class GitCommandResult:
    returncode: int
    stdout: str = ""


GitRunner = Callable[[tuple[str, ...]], GitCommandResult]


@dataclass(frozen=True)
class UpdatePreflight:
    current_head: str | None
    target_head: str | None
    update_available: bool
    update_allowed: bool
    status: str
    reason: str | None = None

    def as_dict(self) -> dict:
        return {
            "schemaVersion": "panel-update.v1",
            "currentHead": self.current_head,
            "targetHead": self.target_head,
            "updateAvailable": self.update_available,
            "updateAllowed": self.update_allowed,
            "status": self.status,
            "reason": self.reason,
        }


class PanelUpdateApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expectedCurrentHead: str = Field(pattern=r"^[0-9a-f]{40}$")
    expectedTargetHead: str = Field(pattern=r"^[0-9a-f]{40}$")


class PanelUpdateService:
    def __init__(
        self,
        *,
        repo_root: Path,
        command_path: Path,
        capability_apply_state_path: Path | None = None,
        dashboard_dist: Path | None = None,
        git_runner: GitRunner | None = None,
        update_owner_alive: UpdateOwnerAlive | None = None,
    ) -> None:
        self.repo_root = repo_root
        self.command_path = command_path
        self.runtime_root = command_path.parent
        self.capability_apply_state_path = capability_apply_state_path
        self.dashboard_dist = dashboard_dist or (repo_root / "apps" / "dashboard" / "dist")
        self.lock_path = self.runtime_root / "update-lock.json"
        self.state_path = self.runtime_root / "update-state.json"
        self._git_runner = git_runner or self._run_git
        self._update_owner_alive = update_owner_alive

    def _handoff_failure_result(self, request_id: str | None) -> str | None:
        """Read only the updater's fixed, request-bound handoff evidence.

        The browser never receives this file or any of its contents.  A result
        is surfaced only for the exact schema/stage/result tuple emitted when
        the target continuation rejects its bounded lease.
        """
        safe_request_id = _safe_request_id(request_id)
        if safe_request_id is None:
            return None
        evidence = _read_json(
            self.runtime_root / "logs" / f"update-handoff-{safe_request_id}.json"
        )
        if (
            not evidence
            or set(evidence) != {"schemaVersion", "requestId", "stage", "result", "updatedAt"}
            or evidence.get("schemaVersion") != 1
            or evidence.get("requestId") != safe_request_id
            or _safe_timestamp(evidence.get("updatedAt")) is None
        ):
            return None
        if evidence.get("stage") == "lease-accepted" and evidence.get("result") == "lease-rejected":
            return "target_handoff_lease_rejected"
        return None

    @classmethod
    def from_environment(cls) -> "PanelUpdateService | None":
        raw_command = os.getenv("PANEL_RUNTIME_COMMAND_PATH", "").strip()
        if not raw_command:
            return None
        repo_root = Path(__file__).resolve().parents[4]
        raw_apply_state = os.getenv("PANEL_CAPABILITY_APPLY_STATE_PATH", "").strip()
        raw_dashboard_dist = os.getenv("PANEL_DASHBOARD_DIST", "").strip()
        return cls(
            repo_root=repo_root,
            command_path=Path(raw_command),
            capability_apply_state_path=Path(raw_apply_state) if raw_apply_state else None,
            dashboard_dist=Path(raw_dashboard_dist) if raw_dashboard_dist else None,
        )

    @property
    def enabled(self) -> bool:
        # Deliberately independent from PANEL_KIOSK_CONTROLS_ENABLED. Hiding or
        # shutting down the kiosk must not implicitly grant software-update authority.
        return _bool_env("PANEL_UPDATE_CONTROLS_ENABLED")

    def _run_git(self, arguments: tuple[str, ...]) -> GitCommandResult:
        result = subprocess.run(
            ["git", *arguments],
            cwd=self.repo_root,
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
            shell=False,
        )
        return GitCommandResult(result.returncode, result.stdout.strip())

    def _git(self, *arguments: str) -> GitCommandResult:
        return self._git_runner(tuple(arguments))

    def _production_artifact_matches_revision(self, revision: str) -> bool:
        marker = self.dashboard_dist / "dashboard-build.json"
        payload = _read_json(marker)
        return bool(
            payload
            and set(payload) == {"schemaVersion", "revision", "profile", "buildId"}
            and payload.get("schemaVersion") == "dashboard-build.v1"
            and payload.get("revision") == revision
            and payload.get("profile") == "accepted-v2"
            and payload.get("buildId") == f"{revision}:accepted-v2"
        )

    def _blocked(
        self,
        reason: str,
        current: str | None = None,
        target: str | None = None,
    ) -> UpdatePreflight:
        return UpdatePreflight(current, target, False, False, "blocked", reason)

    def preflight(self, *, ignore_update_lock: bool = False) -> UpdatePreflight:
        if not ignore_update_lock and software_update_active(
            self.runtime_root,
            owner_alive=self._update_owner_alive,
        ):
            return self._blocked("update_in_progress")
        if capability_apply_active(self.capability_apply_state_path):
            return self._blocked("capability_apply_active")

        inside = self._git("rev-parse", "--is-inside-work-tree")
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            return self._blocked("invalid_repository")

        branch = self._git("branch", "--show-current")
        if branch.returncode != 0 or branch.stdout.strip() != "main":
            return self._blocked("wrong_branch")

        dirty = self._git("status", "--porcelain", "--untracked-files=no")
        if dirty.returncode != 0:
            return self._blocked("invalid_repository")
        if dirty.stdout.strip():
            return self._blocked("dirty_checkout")

        fetched = self._git("fetch", "origin", "main")
        if fetched.returncode != 0:
            return self._blocked("fetch_failed")

        current = self._git("rev-parse", "HEAD")
        target = self._git("rev-parse", "origin/main")
        current_head = current.stdout.strip().lower()
        target_head = target.stdout.strip().lower()
        if (
            current.returncode != 0
            or target.returncode != 0
            or not SHA_PATTERN.fullmatch(current_head)
            or not SHA_PATTERN.fullmatch(target_head)
        ):
            return self._blocked("invalid_repository")

        if current_head == target_head:
            if self._production_artifact_matches_revision(current_head):
                return UpdatePreflight(current_head, target_head, False, False, "up_to_date")
            return UpdatePreflight(
                current_head,
                target_head,
                True,
                True,
                "repair_required",
                "production_artifact_mismatch",
            )

        ancestor = self._git("merge-base", "--is-ancestor", current_head, target_head)
        if ancestor.returncode == 1:
            return self._blocked("diverged", current_head, target_head)
        if ancestor.returncode != 0:
            return self._blocked("invalid_repository", current_head, target_head)

        return UpdatePreflight(current_head, target_head, True, True, "update_available")

    def _write_state(self, state: str, **fields: object) -> None:
        payload = {
            "schemaVersion": 1,
            "status": state,
            "updatedAt": _iso_now(),
        }
        field_names = {
            "request_id": "requestId",
            "current_head": "currentHead",
            "target_head": "targetHead",
            "started_at": "startedAt",
            "phase": "phase",
            "served_revision": "servedRevision",
        }
        for name, output_name in field_names.items():
            if name in fields and fields[name] is not None:
                payload[output_name] = fields[name]
        _atomic_write_json(self.state_path, payload)

    def owner_state(self) -> dict:
        payload = _read_json(self.state_path) or {}
        state_status = payload.get("status") if payload.get("schemaVersion") == 1 else None
        if state_status not in {"idle", "checking", "updating", "success", "failed"}:
            state_status = "idle"

        transaction = _read_json(self.runtime_root / "update-transaction.json")
        transaction_valid = bool(
            transaction
            and transaction.get("schemaVersion") == 1
            and transaction.get("status") == "incomplete"
            and transaction.get("phase") in UPDATE_PHASES
            and _safe_revision(transaction.get("previousHead"))
            and _safe_revision(transaction.get("targetHead"))
            and _safe_request_id(transaction.get("requestId"))
            and _safe_timestamp(transaction.get("updatedAt"))
        )
        lock_payload = _read_json(self.lock_path)
        lock_active = _update_lock_active(
            lock_payload,
            owner_alive=self._update_owner_alive,
        )
        transaction_active = transaction_valid and _recent_update_transaction(transaction)

        # The lease and transaction are the server-owned liveness evidence. A
        # browser cannot keep an update alive, and a stale active state must not
        # remain indefinitely visible after its owner has disappeared.
        active_state = state_status in {"checking", "updating"}
        transaction_needs_owner = transaction_valid and state_status not in {"success", "failed"}
        if (active_state or transaction_needs_owner) and not (lock_active or transaction_active):
            effective_target = (
                _safe_revision(payload.get("targetHead"))
                or (_safe_revision(transaction.get("targetHead")) if transaction_valid else None)
                or _safe_revision(lock_payload.get("expectedTargetHead") if lock_payload else None)
            )
            effective_current = (
                _safe_revision(payload.get("currentHead"))
                or (_safe_revision(transaction.get("previousHead")) if transaction_valid else None)
                or _safe_revision(lock_payload.get("expectedCurrentHead") if lock_payload else None)
            )
            evidence_request_id = (
                _safe_request_id(payload.get("requestId"))
                or (_safe_request_id(transaction.get("requestId")) if transaction_valid else None)
                or _safe_request_id(lock_payload.get("requestId") if lock_payload else None)
            )
            return self._owner_state_payload(
                status="failed",
                payload=payload,
                transaction=transaction if transaction_valid else None,
                current_head=effective_current,
                target_head=effective_target,
                lock_request_id=_safe_request_id(lock_payload.get("requestId") if lock_payload else None),
                lock_updated_at=_safe_timestamp(lock_payload.get("updatedAt") if lock_payload else None),
                result=self._handoff_failure_result(evidence_request_id) or "updater_stale",
            )

        if state_status in {"success", "failed"}:
            # The canonical updater records its terminal result immediately
            # before its finally block removes the lock. Preserve that
            # authoritative result across the short overlap.
            status = state_status
        elif lock_active or transaction_active:
            status = state_status if active_state else "updating"
        else:
            status = state_status
        return self._owner_state_payload(
            status=status,
            payload=payload,
            transaction=transaction if transaction_valid else None,
            current_head=_safe_revision(payload.get("currentHead"))
            or (_safe_revision(transaction.get("previousHead")) if transaction_valid else None)
            or _safe_revision(lock_payload.get("expectedCurrentHead") if lock_payload else None),
            target_head=_safe_revision(payload.get("targetHead"))
            or (_safe_revision(transaction.get("targetHead")) if transaction_valid else None)
            or _safe_revision(lock_payload.get("expectedTargetHead") if lock_payload else None),
            lock_request_id=_safe_request_id(lock_payload.get("requestId") if lock_payload else None),
            lock_updated_at=_safe_timestamp(lock_payload.get("updatedAt") if lock_payload else None),
        )

    def _owner_state_payload(
        self,
        *,
        status: str,
        payload: dict,
        transaction: dict | None,
        current_head: str | None,
        target_head: str | None,
        lock_request_id: str | None,
        lock_updated_at: str | None,
        result: str | None = None,
    ) -> dict:
        output = {"schemaVersion": 1, "status": status}
        updated_at = _safe_timestamp(payload.get("updatedAt"))
        if updated_at is None and transaction is not None:
            updated_at = _safe_timestamp(transaction.get("updatedAt"))
        if updated_at is None:
            updated_at = lock_updated_at
        if updated_at is not None:
            output["updatedAt"] = updated_at

        started_at = _safe_timestamp(payload.get("startedAt"))
        if started_at is not None:
            output["startedAt"] = started_at
        request_id = _safe_request_id(payload.get("requestId"))
        if request_id is None and transaction is not None:
            request_id = _safe_request_id(transaction.get("requestId"))
        if request_id is None:
            request_id = lock_request_id
        if request_id is not None:
            output["requestId"] = request_id
        phase = payload.get("phase")
        if not isinstance(phase, str) or phase not in UPDATE_PHASES:
            phase = None
        if phase is None and transaction is not None:
            phase = transaction.get("phase")
        if not isinstance(phase, str) or phase not in UPDATE_PHASES:
            phase = None
        if phase in UPDATE_PHASES:
            output["phase"] = phase
        if current_head is not None:
            output["currentHead"] = current_head
        if target_head is not None:
            output["targetHead"] = target_head
        served_revision = _safe_revision(payload.get("servedRevision"))
        if served_revision is not None:
            output["servedRevision"] = served_revision

        safe_result = result or payload.get("result")
        if isinstance(safe_result, str) and safe_result in SAFE_OWNER_RESULTS:
            output["result"] = safe_result
        output["events"] = _safe_activity_events(payload.get("events"))

        progress = UPDATE_PHASE_PROGRESS.get(phase, 0)
        if status == "success":
            served_revision = output.get("servedRevision")
            target_revision = output.get("targetHead")
            served_verified = bool(
                safe_result in {"updated", "up_to_date"}
                and isinstance(target_revision, str)
                and served_revision == target_revision
                and self._production_artifact_matches_revision(target_revision)
            )
            progress = 100 if served_verified else 95
        output["progressPercent"] = progress
        return output

    def _clear_stale_lock(self) -> None:
        payload = _read_json(self.lock_path)
        if not _update_lock_active(payload, owner_alive=self._update_owner_alive):
            try:
                self.lock_path.unlink(missing_ok=True)
            except OSError:
                pass

    def _acquire_lock(self, request_id: str, current_head: str, target_head: str) -> bool:
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        self._clear_stale_lock()
        payload = {
            "schemaVersion": 1,
            "status": "updating",
            "requestId": request_id,
            "expectedCurrentHead": current_head,
            "expectedTargetHead": target_head,
            "updatedAt": _iso_now(),
        }
        encoded = (
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        try:
            descriptor = os.open(
                self.lock_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError:
            return False
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        return True

    def _release_lock(self, request_id: str) -> None:
        payload = _read_json(self.lock_path)
        if payload and payload.get("requestId") == request_id:
            try:
                self.lock_path.unlink(missing_ok=True)
            except OSError:
                pass

    def apply(self, expected_current: str, expected_target: str) -> dict:
        request_id = secrets.token_hex(12)
        if capability_apply_active(self.capability_apply_state_path):
            raise HTTPException(status_code=409, detail="capability_apply_active")
        if not self._acquire_lock(request_id, expected_current, expected_target):
            raise HTTPException(status_code=409, detail="update_in_progress")

        try:
            # Keep the exclusive update lock held while re-fetching/revalidating.
            # This closes the check/apply TOCTOU window without opening a second-writer gap.
            preflight = self.preflight(ignore_update_lock=True)
            if (
                preflight.current_head != expected_current
                or preflight.target_head != expected_target
            ):
                raise HTTPException(status_code=409, detail="update_target_changed")
            if not preflight.update_allowed or not preflight.update_available:
                detail = preflight.reason or (
                    "already_up_to_date"
                    if preflight.status == "up_to_date"
                    else "update_not_allowed"
                )
                raise HTTPException(status_code=409, detail=detail)
            if self.command_path.exists():
                raise HTTPException(status_code=409, detail="runtime_command_busy")

            command = {
                "schemaVersion": 1,
                "action": "update_panel",
                "expectedCurrentHead": expected_current,
                "expectedTargetHead": expected_target,
                "requestId": request_id,
                "requestedAt": _iso_now(),
            }
            if preflight.status == "repair_required":
                command["repair"] = True
            _atomic_write_json(self.command_path, command)
            self._write_state(
                "updating",
                request_id=request_id,
                current_head=expected_current,
                target_head=expected_target,
                started_at=_iso_now(),
            )
            return {"accepted": True, "status": "updating"}
        except Exception:
            self._release_lock(request_id)
            raise


def _require_intent(intent: str) -> None:
    if intent != "panel-update":
        raise HTTPException(status_code=403, detail="panel_update_intent_required")


def build_system_update_router(
    access_policy: AccessPolicyStore,
    service: PanelUpdateService | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/system/update", tags=["system"])
    update_service = service or PanelUpdateService.from_environment()

    def require_service() -> PanelUpdateService:
        if update_service is None or not update_service.enabled:
            raise HTTPException(status_code=409, detail="panel_update_disabled")
        return update_service

    @router.post("/check")
    def check_update(
        response: Response,
        x_panel_intent: str = Header(default=""),
    ) -> dict:
        _require_intent(x_panel_intent)
        current = require_service()
        try:
            result = current.preflight()
        except Exception as exc:
            # The UI receives only a fixed owner-safe failure, never git stderr,
            # a local path, environment values, or arbitrary exception text.
            raise HTTPException(status_code=503, detail="update_check_failed") from exc
        response.headers["Cache-Control"] = "no-store"
        return result.as_dict()

    @router.get("/status")
    def update_status(response: Response) -> dict:
        current = require_service()
        response.headers["Cache-Control"] = "no-store"
        return current.owner_state()

    @router.post("/apply", status_code=status.HTTP_202_ACCEPTED)
    def apply_update(
        payload: PanelUpdateApplyRequest,
        response: Response,
        x_panel_intent: str = Header(default=""),
    ) -> dict:
        _require_intent(x_panel_intent)
        current = require_service()
        if access_policy.effective_profile() != "full":
            access_policy.audit_capability(
                "system.panel.update",
                result="full_access_required",
            )
            raise HTTPException(status_code=403, detail="full_access_required")
        result = current.apply(payload.expectedCurrentHead, payload.expectedTargetHead)
        access_policy.audit_capability("system.panel.update", result="accepted")
        response.headers["Cache-Control"] = "no-store"
        return result

    return router
