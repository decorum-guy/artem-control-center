"""Bounded, capability-authenticated Coffee Diary photo handoff.

This module intentionally has no generic file or proxy primitives.  A session
is an in-memory, one-shot capability for one image and one fixed diary intent.
The image directory is server-owned and staged files are kept outside the
canonical diary document until a new bean claims them.
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import tempfile
import time
import warnings
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from threading import RLock
from typing import Callable, Literal, Sequence
from uuid import UUID, uuid4

from .coffee_diary import (
    CoffeeDiaryNotFound,
    CoffeeDiaryPhoto,
    CoffeeDiaryValidationError,
    MAX_PHOTO_BYTES,
)


UPLOAD_SESSION_TTL_SECONDS = 10 * 60
STAGED_ATTACHMENT_GRACE_SECONDS = 30 * 60
MAX_ACTIVE_UPLOAD_SESSIONS = 64
MAX_UPLOAD_REGISTRY_RECORDS = 256
MAX_UPLOAD_ATTEMPTS = 5
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_IMAGE_SIDE = 20_000
MAX_IMAGE_PIXELS = 60_000_000
ACCEPTED_MEDIA_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,}$")
_STAGED_FILE_PATTERN = re.compile(r"^staged-[0-9a-f]{32}\.(?:jpg|png)$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _safe_storage_path(root: Path, storage_id: str) -> Path:
    candidate = (root / storage_id).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise CoffeeDiaryValidationError("coffee_diary_photo_storage_id_invalid") from exc
    if candidate.parent != root:
        raise CoffeeDiaryValidationError("coffee_diary_photo_storage_id_invalid")
    return candidate


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    try:
        directory_fd = os.open(path, os.O_DIRECTORY)
    except OSError:
        return
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


@dataclass(frozen=True)
class NormalizedImage:
    path: Path
    media_type: str
    byte_size: int
    width: int
    height: int
    sha256: str


@dataclass
class UploadSession:
    session_id: UUID
    token_hash: str
    intent: Literal["bean", "bean_create"]
    bean_id: UUID | None
    expires_at: datetime
    deadline: float
    state: Literal["created", "uploading", "uploaded", "consumed", "cancelled", "expired"] = "created"
    failed_attempts: int = 0
    pending_attachment_id: UUID | None = None
    photo_id: UUID | None = None


class UploadResolution(str, Enum):
    """Atomic registry outcomes for a token presented to the upload route."""

    BEGIN_NEW_UPLOAD = "begin_new_upload"
    IN_PROGRESS = "in_progress"
    TERMINAL_UPLOADED = "terminal_uploaded"
    TERMINAL_CONSUMED = "terminal_consumed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    INVALID = "invalid"


@dataclass(frozen=True)
class UploadDecision:
    resolution: UploadResolution
    session: UploadSession | None = None
    terminal_result: dict[str, object] | None = None


@dataclass
class StagedAttachment:
    pending_id: UUID
    session_id: UUID
    path: Path
    media_type: str
    byte_size: int
    width: int
    height: int
    sha256: str
    deadline: float
    state: Literal["uploaded", "claiming", "claimed"] = "uploaded"


@dataclass
class PreparedStagedPhoto:
    pending_id: UUID
    session_id: UUID
    staged_path: Path
    final_path: Path
    photo: CoffeeDiaryPhoto


class PhotoStorage:
    """Server-owned final and short-lived staged image storage."""

    def __init__(self, root: str | Path | None = None, *, cleanup_staged: bool = False) -> None:
        configured = os.getenv("PANEL_COFFEE_DIARY_IMAGE_DIR", "").strip()
        if root is not None:
            selected = Path(root)
        elif configured:
            selected = Path(configured)
        else:
            diary_path = os.getenv("PANEL_COFFEE_DIARY_PATH", "").strip()
            if diary_path:
                # Test/package seams that relocate the durable diary also get
                # a colocated image family without touching the checkout.
                selected = Path(diary_path).expanduser().resolve().parent / "coffee-diary-images"
            else:
                data_root = os.getenv("LOCALAPPDATA", "").strip()
                if data_root:
                    selected = Path(data_root) / "ArtemControlCenter" / "coffee-diary-images"
                else:
                    xdg_root = os.getenv("XDG_DATA_HOME", "").strip()
                    selected = (Path(xdg_root) if xdg_root else Path.home() / ".local" / "share") / "ArtemControlCenter" / "coffee-diary-images"
        self.root = selected.expanduser().resolve()
        self.staged_root = self.root / ".staged"
        if cleanup_staged:
            self.cleanup_staged_files()

    def cleanup_staged_files(self) -> None:
        """Only remove files with this module's exact staged naming scheme."""
        try:
            for candidate in self.staged_root.iterdir():
                if candidate.is_file() and _STAGED_FILE_PATTERN.fullmatch(candidate.name):
                    candidate.unlink(missing_ok=True)
        except OSError:
            pass

    def new_temp_file(self, *, prefix: str = ".coffee-upload-") -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(mode="wb", prefix=prefix, suffix=".tmp", dir=self.root, delete=False)
        path = Path(handle.name)
        handle.close()
        return path

    def _new_normalized_temp(self) -> Path:
        return self.new_temp_file(prefix=".coffee-normalized-")

    def _new_storage_id(self, media_type: str) -> str:
        return f"{uuid4().hex}.png" if media_type == "image/png" else f"{uuid4().hex}.jpg"

    def move_normalized_to_final(self, normalized: NormalizedImage) -> tuple[str, Path]:
        storage_id = self._new_storage_id(normalized.media_type)
        target = _safe_storage_path(self.root, storage_id)
        os.replace(normalized.path, target)
        _fsync_directory(self.root)
        return storage_id, target

    def move_normalized_to_staged(self, normalized: NormalizedImage, pending_id: UUID) -> Path:
        self.staged_root.mkdir(parents=True, exist_ok=True)
        target = self.staged_root / f"staged-{pending_id.hex}{'.png' if normalized.media_type == 'image/png' else '.jpg'}"
        os.replace(normalized.path, target)
        _fsync_directory(self.staged_root)
        return target

    def promote_staged(self, source: Path, media_type: str) -> tuple[str, Path]:
        self.root.mkdir(parents=True, exist_ok=True)
        storage_id = self._new_storage_id(media_type)
        target = _safe_storage_path(self.root, storage_id)
        os.replace(source, target)
        _fsync_directory(self.root)
        return storage_id, target

    def remove(self, path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def final_path(self, storage_id: str) -> Path:
        return _safe_storage_path(self.root, storage_id)


def _validate_image_dimensions(width: int, height: int) -> None:
    if width <= 0 or height <= 0 or width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE or width * height > MAX_IMAGE_PIXELS:
        raise CoffeeDiaryValidationError("coffee_diary_upload_dimensions_invalid")


def _hash_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as handle:
        while chunk := handle.read(128 * 1024):
            total += len(chunk)
            digest.update(chunk)
    return total, digest.hexdigest()


def normalize_image(source: Path, declared_media_type: str, storage: PhotoStorage) -> NormalizedImage:
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
    except ImportError as exc:
        raise CoffeeDiaryValidationError("coffee_diary_upload_image_invalid") from exc
    declared = declared_media_type.split(";", 1)[0].strip().lower()
    if declared not in ACCEPTED_MEDIA_TYPES:
        raise CoffeeDiaryValidationError("coffee_diary_upload_media_type_invalid")
    destination: Path | None = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                actual = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}.get((image.format or "").upper())
                if actual is None:
                    raise CoffeeDiaryValidationError("coffee_diary_upload_media_type_invalid")
                if actual != declared:
                    raise CoffeeDiaryValidationError("coffee_diary_upload_media_type_invalid")
                _validate_image_dimensions(*image.size)
                image.load()
                oriented = ImageOps.exif_transpose(image)
                _validate_image_dimensions(*oriented.size)
                has_alpha = oriented.mode in {"RGBA", "LA"} or "transparency" in oriented.info
                if has_alpha:
                    normalized_media_type = "image/png"
                    output = oriented.convert("RGBA")
                else:
                    normalized_media_type = "image/jpeg"
                    output = oriented.convert("RGB")
                destination = storage._new_normalized_temp()
                if normalized_media_type == "image/png":
                    output.save(destination, format="PNG", optimize=False, compress_level=6)
                else:
                    output.save(destination, format="JPEG", quality=88, optimize=True, progressive=False)
                output.close()
        byte_size, digest = _hash_file(destination)
        if byte_size <= 0 or byte_size > MAX_PHOTO_BYTES:
            raise CoffeeDiaryValidationError("coffee_diary_upload_file_too_large")
        return NormalizedImage(destination, normalized_media_type, byte_size, oriented.width, oriented.height, digest)
    except CoffeeDiaryValidationError:
        if destination is not None:
            storage.remove(destination)
        raise
    except Image.DecompressionBombError as exc:
        if destination is not None:
            storage.remove(destination)
        raise CoffeeDiaryValidationError("coffee_diary_upload_dimensions_invalid") from exc
    except (UnidentifiedImageError, OSError, ValueError, RuntimeError, Warning) as exc:
        if destination is not None:
            storage.remove(destination)
        raise CoffeeDiaryValidationError("coffee_diary_upload_image_invalid") from exc


class PhotoUploadRegistry:
    def __init__(
        self,
        storage: PhotoStorage | None = None,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], datetime] = _now,
    ) -> None:
        self.storage = storage or PhotoStorage(cleanup_staged=True)
        self._monotonic = monotonic
        self._wall_clock = wall_clock
        self._lock = RLock()
        self._sessions: dict[UUID, UploadSession] = {}
        self._staged: dict[UUID, StagedAttachment] = {}

    @property
    def sessions(self) -> dict[UUID, UploadSession]:
        """Read-only-by-convention test/diagnostic view; plaintext tokens are never stored."""
        return self._sessions

    def _cleanup_locked(self) -> None:
        now = self._monotonic()
        for pending_id, attachment in list(self._staged.items()):
            if attachment.state != "claimed" and now >= attachment.deadline:
                self.storage.remove(attachment.path)
                self._staged.pop(pending_id, None)
                session = self._sessions.get(attachment.session_id)
                if session is not None and session.pending_attachment_id == pending_id:
                    session.pending_attachment_id = None
                    if session.state == "uploaded":
                        session.state = "expired"
        for session in self._sessions.values():
            if session.state in {"created", "uploading"} and now >= session.deadline:
                session.state = "expired"
        self._prune_evictable_locked()

    def _session_is_evictable_locked(self, session: UploadSession, now: float) -> bool:
        """Return whether removing a session cannot break a live capability.

        Canonical photos outlive their bearer sessions.  Staged sessions are
        retained while their separate attachment grace window is alive so the
        authenticated panel status and pending preview remain authoritative.
        """
        if session.state in {"cancelled", "expired"}:
            return True
        if session.state == "consumed":
            return now >= session.deadline
        if session.state != "uploaded":
            return False
        if session.pending_attachment_id is None:
            session.state = "expired"
            return True
        attachment = self._staged.get(session.pending_attachment_id)
        if attachment is None:
            session.state = "expired"
            return True
        if attachment.state == "uploaded" and not attachment.path.is_file():
            session.state = "expired"
            return True
        return False

    def _prune_evictable_locked(self, *, slots_needed: int = 0) -> None:
        """Evict only deterministic, safely terminal records under the cap."""
        target = max(0, MAX_UPLOAD_REGISTRY_RECORDS - slots_needed)
        if len(self._sessions) <= target:
            return
        now = self._monotonic()
        evictable = [
            session
            for session in self._sessions.values()
            if self._session_is_evictable_locked(session, now)
        ]
        evictable.sort(key=lambda session: (session.deadline, session.session_id.hex))
        remove_count = len(self._sessions) - target
        for session in evictable[:remove_count]:
            self._sessions.pop(session.session_id, None)

    def create(self, *, intent: Literal["bean", "bean_create"], bean_id: UUID | None) -> tuple[UploadSession, str]:
        with self._lock:
            self._cleanup_locked()
            self._prune_evictable_locked(slots_needed=1)
            active = sum(session.state in {"created", "uploading"} for session in self._sessions.values())
            if active >= MAX_ACTIVE_UPLOAD_SESSIONS or len(self._sessions) >= MAX_UPLOAD_REGISTRY_RECORDS:
                raise CoffeeDiaryValidationError("coffee_diary_upload_sessions_full")
            now = self._wall_clock()
            session = UploadSession(
                session_id=uuid4(),
                token_hash="",
                intent=intent,
                bean_id=bean_id,
                expires_at=now + timedelta(seconds=UPLOAD_SESSION_TTL_SECONDS),
                deadline=self._monotonic() + UPLOAD_SESSION_TTL_SECONDS,
            )
            token = secrets.token_urlsafe(32)
            session.token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
            self._sessions[session.session_id] = session
            return session, token

    def _lookup_by_token_locked(self, token: str) -> UploadSession:
        if not isinstance(token, str) or not _TOKEN_PATTERN.fullmatch(token):
            raise CoffeeDiaryValidationError("coffee_diary_upload_token_invalid")
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        for session in self._sessions.values():
            if secrets.compare_digest(session.token_hash, token_hash):
                return session
        raise CoffeeDiaryValidationError("coffee_diary_upload_token_invalid")

    def _terminal_result_locked(self, session: UploadSession) -> dict[str, object] | None:
        if session.state == "consumed" and session.photo_id is not None:
            return {
                "state": "consumed",
                "photoId": str(session.photo_id),
                "pendingAttachmentId": None,
            }
        if session.state != "uploaded" or session.pending_attachment_id is None:
            return None
        attachment = self._staged.get(session.pending_attachment_id)
        if attachment is None or attachment.state != "uploaded" or not attachment.path.is_file():
            return None
        return {
            "state": "uploaded",
            "photoId": None,
            "pendingAttachmentId": str(attachment.pending_id),
        }

    def resolve_upload(self, token: str) -> UploadDecision:
        """Resolve a token and transition a fresh session atomically.

        Terminal success is returned while holding the registry lock so a
        retry can replay the committed response without touching its request
        body or the server-owned image storage.
        """
        with self._lock:
            self._cleanup_locked()
            try:
                session = self._lookup_by_token_locked(token)
            except CoffeeDiaryValidationError:
                return UploadDecision(UploadResolution.INVALID)
            if session.state in {"uploaded", "consumed"} and self._monotonic() >= session.deadline:
                return UploadDecision(UploadResolution.EXPIRED)
            if session.state == "expired":
                return UploadDecision(UploadResolution.EXPIRED)
            if session.state == "cancelled":
                return UploadDecision(UploadResolution.CANCELLED)
            if session.state == "consumed":
                result = self._terminal_result_locked(session)
                return UploadDecision(UploadResolution.TERMINAL_CONSUMED, terminal_result=result) if result else UploadDecision(UploadResolution.INVALID)
            if session.state == "uploaded":
                attachment = self._staged.get(session.pending_attachment_id) if session.pending_attachment_id is not None else None
                if attachment is not None and attachment.state != "uploaded":
                    return UploadDecision(UploadResolution.IN_PROGRESS)
                result = self._terminal_result_locked(session)
                if result is not None:
                    return UploadDecision(UploadResolution.TERMINAL_UPLOADED, terminal_result=result)
                session.state = "expired"
                return UploadDecision(UploadResolution.EXPIRED)
            if session.state == "uploading":
                return UploadDecision(UploadResolution.IN_PROGRESS)
            if session.state != "created":
                return UploadDecision(UploadResolution.INVALID)
            session.state = "uploading"
            return UploadDecision(UploadResolution.BEGIN_NEW_UPLOAD, session=session)

    def begin_upload(self, token: str) -> UploadSession:
        """Begin a new upload, preserving the legacy exception seam."""
        decision = self.resolve_upload(token)
        if decision.resolution == UploadResolution.BEGIN_NEW_UPLOAD and decision.session is not None:
            return decision.session
        code = {
            UploadResolution.EXPIRED: "coffee_diary_upload_token_expired",
            UploadResolution.CANCELLED: "coffee_diary_upload_token_cancelled",
            UploadResolution.TERMINAL_UPLOADED: "coffee_diary_upload_token_consumed",
            UploadResolution.TERMINAL_CONSUMED: "coffee_diary_upload_token_consumed",
            UploadResolution.IN_PROGRESS: "coffee_diary_upload_in_progress",
        }.get(decision.resolution, "coffee_diary_upload_token_invalid")
        raise CoffeeDiaryValidationError(code)

    def invalid_attempt(self, session_id: UUID) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None or session.state != "uploading":
                return
            session.failed_attempts += 1
            session.state = "expired" if session.failed_attempts >= MAX_UPLOAD_ATTEMPTS else "created"

    def fail_upload(self, session_id: UUID) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None and session.state == "uploading":
                session.state = "created"

    def finish_existing(self, session_id: UUID, photo_id: UUID) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None or session.state != "uploading":
                raise CoffeeDiaryValidationError("coffee_diary_upload_token_invalid")
            session.photo_id = photo_id
            session.state = "consumed"

    def finish_staged(self, session_id: UUID, material: NormalizedImage) -> tuple[UUID, Path]:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None or session.state != "uploading" or session.intent != "bean_create":
                raise CoffeeDiaryValidationError("coffee_diary_upload_token_invalid")
            pending_id = uuid4()
            staged_path = self.storage.move_normalized_to_staged(material, pending_id)
            attachment = StagedAttachment(
                pending_id=pending_id,
                session_id=session_id,
                path=staged_path,
                media_type=material.media_type,
                byte_size=material.byte_size,
                width=material.width,
                height=material.height,
                sha256=material.sha256,
                deadline=self._monotonic() + STAGED_ATTACHMENT_GRACE_SECONDS,
            )
            self._staged[pending_id] = attachment
            session.pending_attachment_id = pending_id
            session.state = "uploaded"
            return pending_id, staged_path

    def status(self, session_id: UUID) -> dict[str, object]:
        with self._lock:
            self._cleanup_locked()
            session = self._sessions.get(session_id)
            if session is None:
                raise CoffeeDiaryNotFound("coffee_diary_upload_session_not_found")
            remaining = max(0, int(session.deadline - self._monotonic())) if session.state in {"created", "uploading"} else 0
            pending = session.pending_attachment_id if session.pending_attachment_id in self._staged else None
            if session.state == "uploaded" and pending is None:
                session.state = "expired"
            return {
                "sessionId": str(session.session_id),
                "state": session.state,
                "expiresAt": _iso(session.expires_at),
                "remainingSeconds": remaining,
                "pendingAttachmentId": str(pending) if pending else None,
                "photoId": str(session.photo_id) if session.photo_id else None,
            }

    def cancel(self, session_id: UUID) -> dict[str, object]:
        with self._lock:
            self._cleanup_locked()
            session = self._sessions.get(session_id)
            if session is None:
                raise CoffeeDiaryNotFound("coffee_diary_upload_session_not_found")
            if session.state == "created":
                session.state = "cancelled"
            return self.status(session_id)

    def discard_pending(self, pending_id: UUID) -> None:
        with self._lock:
            self._cleanup_locked()
            attachment = self._staged.get(pending_id)
            if attachment is None:
                raise CoffeeDiaryNotFound("coffee_diary_staged_attachment_not_found")
            if attachment.state != "uploaded":
                raise CoffeeDiaryValidationError("coffee_diary_upload_token_consumed")
            self.storage.remove(attachment.path)
            self._staged.pop(pending_id, None)
            session = self._sessions.get(attachment.session_id)
            if session is not None and session.pending_attachment_id == pending_id:
                session.pending_attachment_id = None
                session.state = "cancelled"

    def pending_content(self, pending_id: UUID) -> StagedAttachment:
        with self._lock:
            self._cleanup_locked()
            attachment = self._staged.get(pending_id)
            if attachment is None or attachment.state != "uploaded" or not attachment.path.is_file():
                raise CoffeeDiaryNotFound("coffee_diary_staged_attachment_not_found")
            return attachment

    def prepare_pending(
        self,
        pending_ids: Sequence[UUID],
        bean_id: UUID,
    ) -> list[PreparedStagedPhoto]:
        with self._lock:
            self._cleanup_locked()
            unique_ids = list(dict.fromkeys(pending_ids))
            if len(unique_ids) != len(pending_ids):
                raise CoffeeDiaryValidationError("coffee_diary_upload_staged_attachment_invalid")
            attachments: list[StagedAttachment] = []
            for pending_id in unique_ids:
                attachment = self._staged.get(pending_id)
                if attachment is None or attachment.state != "uploaded" or self._monotonic() >= attachment.deadline or not attachment.path.is_file():
                    raise CoffeeDiaryValidationError("coffee_diary_upload_staged_attachment_invalid")
                attachments.append(attachment)
            prepared: list[PreparedStagedPhoto] = []
            try:
                for attachment in attachments:
                    attachment.state = "claiming"
                    storage_id, final_path = self.storage.promote_staged(attachment.path, attachment.media_type)
                    photo = CoffeeDiaryPhoto(
                        id=uuid4(),
                        beanId=bean_id,
                        storageId=storage_id,
                        mediaType=attachment.media_type,
                        byteSize=attachment.byte_size,
                        width=attachment.width,
                        height=attachment.height,
                        sha256=attachment.sha256,
                        createdAt=_iso(self._wall_clock()),
                    )
                    prepared.append(PreparedStagedPhoto(attachment.pending_id, attachment.session_id, attachment.path, final_path, photo))
            except (OSError, CoffeeDiaryValidationError, ValueError) as exc:
                self._rollback_locked(prepared)
                for attachment in attachments:
                    if attachment.state == "claiming":
                        attachment.state = "uploaded"
                raise CoffeeDiaryValidationError("coffee_diary_upload_staged_attachment_invalid") from exc
            return prepared

    def _rollback_locked(self, prepared: Sequence[PreparedStagedPhoto]) -> None:
        for item in prepared:
            try:
                if item.final_path.is_file():
                    os.replace(item.final_path, item.staged_path)
            except OSError:
                self.storage.remove(item.final_path)
            attachment = self._staged.get(item.pending_id)
            if attachment is not None:
                attachment.state = "uploaded"

    def rollback_prepared(self, prepared: Sequence[PreparedStagedPhoto]) -> None:
        with self._lock:
            self._rollback_locked(prepared)

    def finalize_prepared(self, prepared: Sequence[PreparedStagedPhoto]) -> None:
        with self._lock:
            for item in prepared:
                self._staged.pop(item.pending_id, None)
                session = self._sessions.get(item.session_id)
                if session is not None:
                    session.photo_id = item.photo.id
                    session.pending_attachment_id = None
                    session.state = "consumed"
