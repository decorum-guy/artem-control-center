from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

AccessProfile = Literal["read_only", "standard", "full"]
ConfirmationMode = Literal["profile_default", "manual_persistent_full", "temporary_full"]
Availability = Literal[
    "allowed",
    "elevation_required",
    "profile_blocked",
    "pin_not_configured",
    "gate_disabled",
    "integration_unavailable",
    "busy",
    "cooldown",
    "precondition_failed",
]

PROFILE_RANK: dict[AccessProfile, int] = {
    "read_only": 0,
    "standard": 1,
    "full": 2,
}

CAPABILITIES: dict[str, AccessProfile] = {
    "home.coffee.control": "standard",
    "home.coffee.settings.timing": "standard",
    "home.coffee.settings.notifications": "standard",
    "settings.calendar.colors": "standard",
    "settings.ai.providers": "standard",
    "settings.capabilities.manage": "full",
    "planning.reminders.create": "standard",
    "planning.reminders.edit": "standard",
    "planning.reminders.complete": "standard",
    "planning.reminders.cancel": "standard",
    "planning.tasks.create": "standard",
    "planning.tasks.edit": "standard",
    "planning.tasks.complete": "standard",
    "planning.tasks.archive": "standard",
    "planning.calendar.create": "standard",
    "planning.calendar.edit": "standard",
    "planning.calendar.delete": "standard",
    "calendar.write": "standard",
    "tasks.write": "standard",
    "avalar.main.smoke": "standard",
    "avalar.stage.smoke": "standard",
    "avalar.main.restart": "full",
    "avalar.stage.restart": "full",
    "avalar.stage.deploy": "full",
    "avalar.main.deploy": "full",
    "backup.create": "full",
    "backup.restore": "full",
    "proxy.allowlist.write": "full",
}

PBKDF2_ITERATIONS = 310_000
MAX_FAILED_UNLOCKS = 5
FAILED_WINDOW = timedelta(minutes=5)
LOCKOUT_DURATION = timedelta(minutes=5)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class CapabilityDecision:
    capability: str
    minimum_profile: AccessProfile
    effective_profile: AccessProfile
    allowed: bool
    availability: Availability

    def as_dict(self) -> dict[str, Any]:
        return {
            "capability": self.capability,
            "minimumProfile": self.minimum_profile,
            "effectiveProfile": self.effective_profile,
            "allowed": self.allowed,
            "availability": self.availability,
        }


@dataclass(frozen=True)
class ConfirmationPolicy:
    """Server-owned human-confirmation semantics for registered actions.

    This is deliberately separate from capability authorization.  Manual
    persistent Full represents trusted-owner intent and waives only the
    redundant UI/phrase ceremony; it does not grant a capability.
    """

    action_confirmation_required: bool
    mode: ConfirmationMode

    def as_dict(self) -> dict[str, Any]:
        return {
            "actionConfirmationRequired": self.action_confirmation_required,
            "mode": self.mode,
        }


class AccessPolicyStore:
    def __init__(
        self,
        path: str | Path,
        *,
        audit_dir: str | Path | None = None,
        temporary_minutes: int = 30,
        now=utc_now,
    ) -> None:
        self.path = Path(path)
        self.audit_dir = Path(audit_dir) if audit_dir else self.path.parent / "audit"
        self.temporary_minutes = max(1, temporary_minutes)
        self._now = now
        self._lock = RLock()
        self._state = self._load_state()

    @classmethod
    def from_environment(cls, *, temporary_minutes: int = 30) -> "AccessPolicyStore":
        runtime_root = Path(
            os.getenv("LOCALAPPDATA", "") or Path.cwd() / ".runtime"
        ) / "ArtemControlCenter"
        path = Path(os.getenv("PANEL_ACCESS_POLICY_PATH", "") or runtime_root / "access-policy.json")
        audit_dir = Path(os.getenv("PANEL_ACCESS_AUDIT_DIR", "") or runtime_root / "audit")
        return cls(path, audit_dir=audit_dir, temporary_minutes=temporary_minutes)

    def _safe_state(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "revision": 0,
            "baseProfile": "read_only",
            "temporaryFullExpiresAt": None,
            "pin": None,
            "failedUnlocks": [],
            "lockoutUntil": None,
        }

    def _load_state(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._safe_state()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if payload.get("schemaVersion") != 1:
                raise ValueError("unsupported schema")
            if payload.get("baseProfile") not in PROFILE_RANK:
                raise ValueError("invalid profile")
            pin = payload.get("pin")
            if pin is not None and (
                not isinstance(pin, dict)
                or pin.get("algorithm") != "pbkdf2_sha256"
                or not isinstance(pin.get("salt"), str)
                or not isinstance(pin.get("digest"), str)
                or not isinstance(pin.get("iterations"), int)
            ):
                raise ValueError("invalid pin hash")
            payload.setdefault("revision", 0)
            payload.setdefault("temporaryFullExpiresAt", None)
            payload.setdefault("failedUnlocks", [])
            payload.setdefault("lockoutUntil", None)
            return payload
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            self._audit("policy_recovery", result="fallback_read_only")
            return self._safe_state()

    def _atomic_write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + f".{os.getpid()}.tmp")
        temporary.write_text(
            json.dumps(self._state, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)

    def _audit(self, event: str, **fields: Any) -> None:
        try:
            self.audit_dir.mkdir(parents=True, exist_ok=True)
            now = self._now()
            record = {
                "schemaVersion": 1,
                "event": event,
                "observedAt": iso(now),
                **fields,
            }
            target = self.audit_dir / f"access-audit-{now.date().isoformat()}.jsonl"
            with target.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            cutoff = now.date() - timedelta(days=14)
            for candidate in self.audit_dir.glob("access-audit-*.jsonl"):
                try:
                    day = datetime.strptime(candidate.stem.removeprefix("access-audit-"), "%Y-%m-%d").date()
                    if day < cutoff:
                        candidate.unlink(missing_ok=True)
                except ValueError:
                    continue
        except OSError:
            # Authorization must fail closed even when audit storage is unavailable.
            pass

    def _bump(self) -> None:
        self._state["revision"] = int(self._state.get("revision", 0)) + 1
        self._atomic_write()

    def _temporary_expiry(self) -> datetime | None:
        expiry = parse_datetime(self._state.get("temporaryFullExpiresAt"))
        if expiry and expiry <= self._now():
            self._state["temporaryFullExpiresAt"] = None
            self._bump()
            self._audit("temporary_full_expired", result="standard")
            return None
        return expiry

    @property
    def base_profile(self) -> AccessProfile:
        return self._state["baseProfile"]

    @property
    def pin_configured(self) -> bool:
        return isinstance(self._state.get("pin"), dict)

    def effective_profile(self) -> AccessProfile:
        with self._lock:
            if self.base_profile == "full":
                return "full"
            if self.base_profile == "standard" and self._temporary_expiry() is not None:
                return "full"
            return self.base_profile

    def confirmation_policy(self) -> ConfirmationPolicy:
        """Derive confirmation semantics from trusted persisted policy state."""
        with self._lock:
            if self.base_profile == "full":
                return ConfirmationPolicy(False, "manual_persistent_full")
            if self.base_profile == "standard" and self._temporary_expiry() is not None:
                return ConfirmationPolicy(True, "temporary_full")
            return ConfirmationPolicy(True, "profile_default")

    def status(self) -> dict[str, Any]:
        with self._lock:
            expiry = self._temporary_expiry()
            effective = self.effective_profile()
            confirmation_policy = self.confirmation_policy()
            return {
                "schemaVersion": 1,
                "revision": int(self._state.get("revision", 0)),
                "baseProfile": self.base_profile,
                "effectiveProfile": effective,
                "temporaryFull": expiry is not None and self.base_profile != "full",
                "temporaryFullExpiresAt": iso(expiry),
                "pinConfigured": self.pin_configured,
                "lockoutUntil": iso(self._active_lockout()),
                "confirmationPolicy": confirmation_policy.as_dict(),
                "capabilities": {
                    capability: self.authorize(capability).as_dict()
                    for capability in CAPABILITIES
                },
            }

    def _active_lockout(self) -> datetime | None:
        lockout = parse_datetime(self._state.get("lockoutUntil"))
        if lockout and lockout > self._now():
            return lockout
        if lockout:
            self._state["lockoutUntil"] = None
            self._state["failedUnlocks"] = []
            self._bump()
        return None

    def set_pin(self, pin: str) -> None:
        if not pin.isdigit() or not 4 <= len(pin) <= 12:
            raise ValueError("PIN must contain 4-12 digits")
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            pin.encode("utf-8"),
            salt,
            PBKDF2_ITERATIONS,
        )
        with self._lock:
            self._state["pin"] = {
                "algorithm": "pbkdf2_sha256",
                "iterations": PBKDF2_ITERATIONS,
                "salt": base64.b64encode(salt).decode("ascii"),
                "digest": base64.b64encode(digest).decode("ascii"),
            }
            self._state["failedUnlocks"] = []
            self._state["lockoutUntil"] = None
            self._bump()
            self._audit("pin_changed", result="success")

    def _verify_pin(self, pin: str) -> bool:
        with self._lock:
            if self._active_lockout() is not None:
                self._audit("unlock_failed", result="rate_limited")
                raise PermissionError("pin_rate_limited")
            config = self._state.get("pin")
            if not isinstance(config, dict):
                raise PermissionError("pin_not_configured")
            try:
                salt = base64.b64decode(config["salt"], validate=True)
                expected = base64.b64decode(config["digest"], validate=True)
                actual = hashlib.pbkdf2_hmac(
                    "sha256",
                    pin.encode("utf-8"),
                    salt,
                    int(config["iterations"]),
                )
            except (KeyError, ValueError, TypeError):
                raise PermissionError("pin_not_configured")
            if hmac.compare_digest(actual, expected):
                self._state["failedUnlocks"] = []
                self._state["lockoutUntil"] = None
                self._bump()
                return True

            now = self._now()
            recent = [
                moment
                for value in self._state.get("failedUnlocks", [])
                if (moment := parse_datetime(value)) is not None
                and now - moment <= FAILED_WINDOW
            ]
            recent.append(now)
            self._state["failedUnlocks"] = [iso(moment) for moment in recent]
            if len(recent) >= MAX_FAILED_UNLOCKS:
                self._state["lockoutUntil"] = iso(now + LOCKOUT_DURATION)
            self._bump()
            self._audit("unlock_failed", result="invalid_pin")
            raise PermissionError("invalid_pin")

    def unlock_temporary(self, pin: str) -> dict[str, Any]:
        with self._lock:
            if self.base_profile != "standard":
                raise ValueError("temporary_full_requires_standard")
            self._verify_pin(pin)
            expiry = self._now() + timedelta(minutes=self.temporary_minutes)
            self._state["temporaryFullExpiresAt"] = iso(expiry)
            self._bump()
            self._audit("temporary_full_granted", result="success", expiresAt=iso(expiry))
            return self.status()

    def set_profile(self, profile: AccessProfile, *, pin: str | None = None) -> dict[str, Any]:
        with self._lock:
            if profile == "full":
                if pin is None:
                    raise PermissionError("pin_required")
                self._verify_pin(pin)
            previous = self.base_profile
            self._state["baseProfile"] = profile
            self._state["temporaryFullExpiresAt"] = None
            self._bump()
            self._audit("profile_changed", previous=previous, current=profile, result="success")
            return self.status()

    def clear_temporary(self) -> dict[str, Any]:
        with self._lock:
            if self._state.get("temporaryFullExpiresAt") is not None:
                self._state["temporaryFullExpiresAt"] = None
                self._bump()
                self._audit("temporary_full_cleared", result="success")
            return self.status()

    def authorize(
        self,
        capability: str,
        *,
        gate_enabled: bool = True,
        integration_available: bool = True,
        busy: bool = False,
        cooldown: bool = False,
        precondition_ok: bool = True,
    ) -> CapabilityDecision:
        minimum = CAPABILITIES.get(capability)
        if minimum is None:
            return CapabilityDecision(
                capability,
                "full",
                self.effective_profile(),
                False,
                "profile_blocked",
            )
        effective = self.effective_profile()
        if not gate_enabled:
            availability: Availability = "gate_disabled"
        elif not integration_available:
            availability = "integration_unavailable"
        elif busy:
            availability = "busy"
        elif cooldown:
            availability = "cooldown"
        elif not precondition_ok:
            availability = "precondition_failed"
        elif PROFILE_RANK[effective] >= PROFILE_RANK[minimum]:
            availability = "allowed"
        elif minimum == "full" and effective == "standard":
            availability = "elevation_required" if self.pin_configured else "pin_not_configured"
        else:
            availability = "profile_blocked"
        return CapabilityDecision(
            capability,
            minimum,
            effective,
            availability == "allowed",
            availability,
        )

    def require(self, capability: str, **conditions: Any) -> CapabilityDecision:
        decision = self.authorize(capability, **conditions)
        if decision.allowed:
            return decision
        code = {
            "elevation_required": status.HTTP_403_FORBIDDEN,
            "profile_blocked": status.HTTP_403_FORBIDDEN,
            "pin_not_configured": status.HTTP_409_CONFLICT,
            "gate_disabled": status.HTTP_409_CONFLICT,
            "integration_unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
            "busy": status.HTTP_409_CONFLICT,
            "cooldown": status.HTTP_429_TOO_MANY_REQUESTS,
            "precondition_failed": status.HTTP_409_CONFLICT,
        }[decision.availability]
        raise HTTPException(status_code=code, detail=decision.availability)

    def audit_capability(self, capability: str, *, result: str, correlation_id: str | None = None) -> None:
        self._audit(
            "capability_execution",
            capability=capability,
            effectiveProfile=self.effective_profile(),
            result=result,
            correlationId=correlation_id,
        )


class UnlockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pin: str = Field(min_length=4, max_length=12, pattern=r"^[0-9]+$")


class ProfilePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile: AccessProfile
    pin: str | None = Field(default=None, min_length=4, max_length=12, pattern=r"^[0-9]+$")


def build_access_router(store: AccessPolicyStore) -> APIRouter:
    router = APIRouter(prefix="/api/v1/access", tags=["access"])

    @router.get("")
    def get_access(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return store.status()

    @router.post("/unlock")
    def unlock(payload: UnlockRequest, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        try:
            return store.unlock_temporary(payload.pin)
        except PermissionError as exc:
            detail = str(exc)
            code = 429 if detail == "pin_rate_limited" else 403
            if detail == "pin_not_configured":
                code = 409
            raise HTTPException(status_code=code, detail=detail)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @router.post("/lock")
    def lock(response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        return store.clear_temporary()

    @router.patch("/profile")
    def patch_profile(payload: ProfilePatch, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        try:
            return store.set_profile(payload.profile, pin=payload.pin)
        except PermissionError as exc:
            detail = str(exc)
            code = 429 if detail == "pin_rate_limited" else 403
            if detail == "pin_not_configured":
                code = 409
            raise HTTPException(status_code=code, detail=detail)

    return router
