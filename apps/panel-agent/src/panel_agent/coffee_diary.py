"""Panel-owned durable Coffee Diary storage.

The diary is deliberately a fixed, typed resource.  It is not a generic JSON
store and it has no relationship to the Home Assistant coffee-machine state.
"""

from __future__ import annotations

import errno
import hashlib
import json
import math
import os
import re
import tempfile
import time
import unicodedata
from contextlib import contextmanager
from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from threading import RLock
from typing import Any, Iterator, Mapping, Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, UUID4, field_validator, model_validator

SCHEMA_VERSION = "coffee.diary.v1"
EXPORT_SCHEMA_VERSION = "coffee.diary.export.v1"
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_REQUEST_BYTES = 256 * 1024
MAX_BEANS = 500
MAX_EXTRACTIONS = 5_000
MAX_IDEMPOTENCY_RECORDS = 256
MAX_COLLECTION_BEANS = 200
MAX_COLLECTION_EXTRACTIONS = 200
MAX_PHOTOS = 2_000
MAX_PHOTOS_PER_BEAN = 24
MAX_PHOTO_BYTES = 25 * 1024 * 1024
_LOCK_TIMEOUT_SECONDS = 2.0
_LOCK_RETRY_SECONDS = 0.02
_IDEMPOTENCY_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_STORAGE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_UTC_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_PREFERRED_DRINKS = {"espresso", "milk", "universal"}


def _safe_text(value: str, *, limit: int, required: bool = False) -> str:
    if not isinstance(value, str):
        raise ValueError("coffee_diary_text_invalid")
    normalized = value.strip()
    if required and not normalized:
        raise ValueError("coffee_diary_text_blank")
    if len(normalized) > limit:
        raise ValueError("coffee_diary_text_too_long")
    if any(unicodedata.category(character).startswith("C") for character in value):
        raise ValueError("coffee_diary_text_control_character")
    if "<" in value or ">" in value:
        raise ValueError("coffee_diary_markup_not_allowed")
    return normalized


def _optional_text(value: Optional[str], *, limit: int) -> Optional[str]:
    if value is None:
        return None
    normalized = _safe_text(value, limit=limit)
    return normalized or None


def _utc_timestamp(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("coffee_diary_timestamp_invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("coffee_diary_timestamp_invalid") from exc
    if parsed.tzinfo is None:
        raise ValueError("coffee_diary_timestamp_timezone_required")
    normalized = parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if normalized != value and not value.endswith("+00:00"):
        # Request values may contain milliseconds or another UTC offset and
        # are normalized once.  Persisted documents are checked for exact
        # canonical equality by the store below.
        return normalized
    return normalized


def _canonical_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _roast_date(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if not _DATE_PATTERN.fullmatch(value):
        raise ValueError("coffee_diary_roast_date_invalid")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("coffee_diary_roast_date_invalid") from exc
    return value


def _grams(value: object) -> StrictFloat | StrictInt:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("coffee_diary_grams_invalid")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("coffee_diary_grams_invalid")
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("coffee_diary_grams_invalid") from exc
    if decimal <= 0 or decimal > Decimal("1000"):
        raise ValueError("coffee_diary_grams_invalid")
    if decimal.as_tuple().exponent < -1:
        raise ValueError("coffee_diary_grams_precision_invalid")
    return value  # type: ignore[return-value]


class CoffeeDiaryPhoto(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID4
    beanId: UUID4
    storageId: str = Field(min_length=1, max_length=128, pattern=_STORAGE_ID_PATTERN.pattern)
    mediaType: str = Field(min_length=1, max_length=64, pattern=r"^image/[a-z0-9.+-]+$")
    byteSize: int = Field(gt=0, le=MAX_PHOTO_BYTES)
    width: int = Field(gt=0, le=20_000)
    height: int = Field(gt=0, le=20_000)
    sha256: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    createdAt: str
    deletedAt: Optional[str] = None

    @field_validator("storageId")
    @classmethod
    def _storage_id(cls, value: str) -> str:
        if "/" in value or "\\" in value:
            raise ValueError("coffee_diary_photo_storage_id_invalid")
        return value

    @field_validator("createdAt", "deletedAt")
    @classmethod
    def _timestamps(cls, value: Optional[str]) -> Optional[str]:
        return _utc_timestamp(value) if value is not None else None


class CoffeeDiaryBean(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID4
    version: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=96)
    grindDescription: Optional[str] = Field(default=None, max_length=240)
    preferredDrink: Optional[str] = Field(default=None)
    roaster: Optional[str] = Field(default=None, max_length=96)
    roastDate: Optional[str] = Field(default=None, max_length=10)
    roastLevel: Optional[str] = Field(default=None, max_length=64)
    roastNotes: Optional[str] = Field(default=None, max_length=240)
    origin: Optional[str] = Field(default=None, max_length=96)
    processing: Optional[str] = Field(default=None, max_length=96)
    notes: Optional[str] = Field(default=None, max_length=2_000)
    favoriteExtractionId: Optional[UUID4] = None
    photoIds: list[UUID4] = Field(default_factory=list, max_length=MAX_PHOTOS_PER_BEAN)
    createdAt: str
    updatedAt: str
    deletedAt: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _safe_text(value, limit=96, required=True)

    @field_validator("grindDescription")
    @classmethod
    def _grind_description(cls, value: Optional[str]) -> Optional[str]:
        return _optional_text(value, limit=240)

    @field_validator("preferredDrink", mode="before")
    @classmethod
    def _preferred_drink(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in _PREFERRED_DRINKS:
            raise ValueError("coffee_diary_preferred_drink_invalid")
        return value

    @field_validator("roaster", "origin", "processing")
    @classmethod
    def _short_optional(cls, value: Optional[str]) -> Optional[str]:
        return _optional_text(value, limit=96)

    @field_validator("roastLevel")
    @classmethod
    def _roast_level(cls, value: Optional[str]) -> Optional[str]:
        return _optional_text(value, limit=64)

    @field_validator("roastNotes")
    @classmethod
    def _roast_notes(cls, value: Optional[str]) -> Optional[str]:
        return _optional_text(value, limit=240)

    @field_validator("notes")
    @classmethod
    def _notes(cls, value: Optional[str]) -> Optional[str]:
        return _optional_text(value, limit=2_000)

    @field_validator("roastDate")
    @classmethod
    def _date(cls, value: Optional[str]) -> Optional[str]:
        return _roast_date(value)

    @field_validator("createdAt", "updatedAt", "deletedAt")
    @classmethod
    def _timestamps(cls, value: Optional[str]) -> Optional[str]:
        return _utc_timestamp(value) if value is not None else None


class CoffeeDiaryExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID4
    version: int = Field(ge=1)
    beanId: UUID4
    brewedAt: str
    doseGrams: StrictFloat | StrictInt
    extractionSeconds: int = Field(ge=1, le=3_600)
    yieldGrams: StrictFloat | StrictInt
    notes: Optional[str] = Field(default=None, max_length=4_000)
    rating: Optional[int] = Field(default=None, ge=1, le=10)
    createdAt: str
    updatedAt: str
    deletedAt: Optional[str] = None

    @field_validator("brewedAt", "createdAt", "updatedAt", "deletedAt")
    @classmethod
    def _timestamps(cls, value: Optional[str]) -> Optional[str]:
        return _utc_timestamp(value) if value is not None else None

    @field_validator("doseGrams", "yieldGrams", mode="before")
    @classmethod
    def _grams_value(cls, value: object) -> StrictFloat | StrictInt:
        return _grams(value)

    @field_validator("notes")
    @classmethod
    def _notes(cls, value: Optional[str]) -> Optional[str]:
        return _optional_text(value, limit=4_000)

class CoffeeDiaryIdempotencyRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    key: str = Field(min_length=8, max_length=128, pattern=_IDEMPOTENCY_PATTERN.pattern)
    operation: str = Field(pattern=r"^(bean.create|extraction.create)$")
    requestHash: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    resourceId: UUID4


class CoffeeDiaryDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schemaVersion: str = Field(pattern=r"^coffee\.diary\.v1$")
    revision: int = Field(ge=0)
    updatedAt: str
    beans: list[CoffeeDiaryBean] = Field(default_factory=list, max_length=MAX_BEANS)
    extractions: list[CoffeeDiaryExtraction] = Field(default_factory=list, max_length=MAX_EXTRACTIONS)
    photos: list[CoffeeDiaryPhoto] = Field(default_factory=list, max_length=MAX_PHOTOS)
    idempotency: list[CoffeeDiaryIdempotencyRecord] = Field(default_factory=list, max_length=MAX_IDEMPOTENCY_RECORDS)

    @field_validator("updatedAt")
    @classmethod
    def _updated_at(cls, value: str) -> str:
        return _utc_timestamp(value)

    @model_validator(mode="after")
    def _relationships(self) -> "CoffeeDiaryDocument":
        bean_by_id = {bean.id: bean for bean in self.beans}
        extraction_by_id = {extraction.id: extraction for extraction in self.extractions}
        photo_by_id = {photo.id: photo for photo in self.photos}
        if len(bean_by_id) != len(self.beans) or len(extraction_by_id) != len(self.extractions) or len(photo_by_id) != len(self.photos):
            raise ValueError("coffee_diary_relationship_duplicate_id")

        for extraction in self.extractions:
            if extraction.beanId not in bean_by_id:
                raise ValueError("coffee_diary_relationship_orphaned_resource")

        for photo in self.photos:
            if photo.beanId not in bean_by_id:
                raise ValueError("coffee_diary_relationship_orphaned_resource")

        photo_reference_counts: dict[UUID, int] = {}
        for bean in self.beans:
            if bean.favoriteExtractionId is not None:
                favorite = extraction_by_id.get(bean.favoriteExtractionId)
                if favorite is None or favorite.deletedAt is not None or favorite.beanId != bean.id:
                    raise ValueError("coffee_diary_favorite_extraction_invalid")
            if len(set(bean.photoIds)) != len(bean.photoIds):
                raise ValueError("coffee_diary_relationship_duplicate_id")
            for photo_id in bean.photoIds:
                photo = photo_by_id.get(photo_id)
                if photo is None or photo.deletedAt is not None or photo.beanId != bean.id:
                    raise ValueError("coffee_diary_photo_relationship_invalid")

                photo_reference_counts[photo_id] = photo_reference_counts.get(photo_id, 0) + 1

        for photo in self.photos:
            references = photo_reference_counts.get(photo.id, 0)
            if photo.deletedAt is None and references != 1:
                raise ValueError("coffee_diary_photo_relationship_invalid")
            if photo.deletedAt is not None and references != 0:
                raise ValueError("coffee_diary_photo_relationship_invalid")
        return self


class CoffeeDiaryExport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schemaVersion: str = Field(pattern=r"^coffee\.diary\.export\.v1$")
    sourceSchemaVersion: str = Field(pattern=r"^coffee\.diary\.v1$")
    revision: int = Field(ge=0)
    updatedAt: str
    beans: list[CoffeeDiaryBean] = Field(max_length=MAX_BEANS)
    extractions: list[CoffeeDiaryExtraction] = Field(max_length=MAX_EXTRACTIONS)
    photos: list[CoffeeDiaryPhoto] = Field(max_length=MAX_PHOTOS)


class CoffeeDiaryBeanCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str = Field(min_length=1, max_length=96)
    grindDescription: Optional[str] = Field(default=None, max_length=240)
    preferredDrink: Optional[str] = Field(default=None)
    roaster: Optional[str] = Field(default=None, max_length=96)
    roastDate: Optional[str] = Field(default=None, max_length=10)
    roastLevel: Optional[str] = Field(default=None, max_length=64)
    roastNotes: Optional[str] = Field(default=None, max_length=240)
    origin: Optional[str] = Field(default=None, max_length=96)
    processing: Optional[str] = Field(default=None, max_length=96)
    notes: Optional[str] = Field(default=None, max_length=2_000)

    @model_validator(mode="after")
    def _validate_texts(self) -> "CoffeeDiaryBeanCreate":
        CoffeeDiaryBean(
            id=uuid4(), version=1, name=self.name, grindDescription=self.grindDescription,
            preferredDrink=self.preferredDrink, roaster=self.roaster,
            roastDate=self.roastDate, roastLevel=self.roastLevel, roastNotes=self.roastNotes,
            origin=self.origin, processing=self.processing, notes=self.notes,
            favoriteExtractionId=None, photoIds=[], createdAt=_canonical_now(), updatedAt=_canonical_now(),
        )
        return self

    @field_validator("grindDescription")
    @classmethod
    def _grind_description(cls, value: Optional[str]) -> Optional[str]:
        return _optional_text(value, limit=240)

    @field_validator("preferredDrink", mode="before")
    @classmethod
    def _preferred_drink(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in _PREFERRED_DRINKS:
            raise ValueError("coffee_diary_preferred_drink_invalid")
        return value


class CoffeeDiaryBeanPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: Optional[str] = Field(default=None, min_length=1, max_length=96)
    grindDescription: Optional[str] = Field(default=None, max_length=240)
    preferredDrink: Optional[str] = Field(default=None)
    roaster: Optional[str] = Field(default=None, max_length=96)
    roastDate: Optional[str] = Field(default=None, max_length=10)
    roastLevel: Optional[str] = Field(default=None, max_length=64)
    roastNotes: Optional[str] = Field(default=None, max_length=240)
    origin: Optional[str] = Field(default=None, max_length=96)
    processing: Optional[str] = Field(default=None, max_length=96)
    notes: Optional[str] = Field(default=None, max_length=2_000)

    @model_validator(mode="after")
    def _non_empty(self) -> "CoffeeDiaryBeanPatch":
        if not self.model_fields_set:
            raise ValueError("coffee_diary_patch_empty")
        supplied = self.model_dump(exclude_unset=True)
        if "name" in supplied:
            _safe_text(supplied["name"], limit=96, required=True)
        for field, limit in (("grindDescription", 240), ("roaster", 96), ("origin", 96), ("processing", 96), ("roastLevel", 64), ("roastNotes", 240), ("notes", 2_000)):
            if field in supplied:
                _optional_text(supplied[field], limit=limit)
        if "roastDate" in supplied:
            _roast_date(supplied["roastDate"])
        if "preferredDrink" in supplied and supplied["preferredDrink"] is not None and supplied["preferredDrink"] not in _PREFERRED_DRINKS:
            raise ValueError("coffee_diary_preferred_drink_invalid")
        return self


class CoffeeDiaryExtractionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    brewedAt: str
    doseGrams: StrictFloat | StrictInt
    extractionSeconds: int = Field(ge=1, le=3_600)
    yieldGrams: StrictFloat | StrictInt
    notes: Optional[str] = Field(default=None, max_length=4_000)
    rating: Optional[int] = Field(default=None, ge=1, le=10)
    makeFavorite: bool = False

    @model_validator(mode="after")
    def _validate(self) -> "CoffeeDiaryExtractionCreate":
        CoffeeDiaryExtraction(
            id=uuid4(), version=1, beanId=uuid4(), brewedAt=self.brewedAt,
            doseGrams=self.doseGrams, extractionSeconds=self.extractionSeconds, yieldGrams=self.yieldGrams,
            notes=self.notes, rating=self.rating, createdAt=_canonical_now(), updatedAt=_canonical_now(),
        )
        return self

    @field_validator("doseGrams", "yieldGrams", mode="before")
    @classmethod
    def _grams_value(cls, value: object) -> StrictFloat | StrictInt:
        return _grams(value)


class CoffeeDiaryFavoriteExtractionPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    extractionId: Optional[UUID4] = None

    @field_validator("extractionId", mode="before")
    @classmethod
    def _uuid_value(cls, value: object) -> object:
        if value is None or isinstance(value, UUID):
            return value
        if not isinstance(value, str):
            raise ValueError("coffee_diary_favorite_extraction_invalid")
        try:
            parsed = UUID(value)
        except ValueError as exc:
            raise ValueError("coffee_diary_favorite_extraction_invalid") from exc
        if parsed.version != 4:
            raise ValueError("coffee_diary_favorite_extraction_invalid")
        return parsed

    @model_validator(mode="after")
    def _required(self) -> "CoffeeDiaryFavoriteExtractionPatch":
        if "extractionId" not in self.model_fields_set:
            raise ValueError("coffee_diary_favorite_extraction_required")
        return self


class CoffeeDiaryCollection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schemaVersion: str = Field(pattern=r"^coffee\.diary\.v1$")
    revision: int = Field(ge=0)
    updatedAt: str
    beans: list[CoffeeDiaryBean] = Field(max_length=MAX_COLLECTION_BEANS)
    recentExtractions: list[CoffeeDiaryExtraction] = Field(max_length=MAX_COLLECTION_EXTRACTIONS)
    photos: list[CoffeeDiaryPhoto] = Field(max_length=MAX_PHOTOS)
    beanCount: int = Field(ge=0)
    extractionCount: int = Field(ge=0)


class CoffeeDiaryBeanDetail(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    bean: CoffeeDiaryBean
    extractions: list[CoffeeDiaryExtraction] = Field(max_length=MAX_COLLECTION_EXTRACTIONS)


class CoffeeDiaryStoreUnavailable(RuntimeError):
    def __init__(self, code: str = "coffee_diary_store_unavailable") -> None:
        super().__init__(code)
        self.code = code


class CoffeeDiaryConflict(RuntimeError):
    pass


class CoffeeDiaryNotFound(RuntimeError):
    pass


class CoffeeDiaryValidationError(ValueError):
    pass


def coffee_diary_store_path() -> Path:
    configured = os.getenv("PANEL_COFFEE_DIARY_PATH", "").strip()
    if configured:
        return Path(configured)
    root = Path(os.getenv("LOCALAPPDATA", "") or Path.cwd() / ".runtime") / "ArtemControlCenter"
    return root / "coffee-diary.json"


@contextmanager
def _file_lock(path: Path) -> Iterator[None]:
    lock_path = path.with_name(f".{path.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        deadline = time.monotonic() + _LOCK_TIMEOUT_SECONDS
        locked = False

        def retry_or_raise(exc: OSError) -> None:
            if time.monotonic() >= deadline:
                raise CoffeeDiaryStoreUnavailable("coffee_diary_store_lock_busy") from exc
            time.sleep(min(_LOCK_RETRY_SECONDS, max(0.0, deadline - time.monotonic())))

        if os.name == "nt":
            import msvcrt
            while not locked:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    locked = True
                except OSError as exc:
                    if not isinstance(exc, PermissionError) and getattr(exc, "errno", None) not in {
                        errno.EACCES,
                        errno.EAGAIN,
                    }:
                        raise
                    retry_or_raise(exc)
        else:
            import fcntl
            while not locked:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locked = True
                except OSError as exc:
                    if getattr(exc, "errno", None) not in {errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK}:
                        raise
                    retry_or_raise(exc)
        try:
            yield
        finally:
            if locked and os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            elif locked:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _empty_document() -> CoffeeDiaryDocument:
    return CoffeeDiaryDocument(schemaVersion=SCHEMA_VERSION, revision=0, updatedAt="1970-01-01T00:00:00Z")


def _json_bytes(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


class CoffeeDiaryStore:
    def __init__(self, path: str | Path | None = None, *, writes_enabled: bool = False) -> None:
        self.path = Path(path) if path else coffee_diary_store_path()
        self.writes_enabled = writes_enabled
        self._thread_lock = RLock()

    @classmethod
    def from_environment(cls, *, writes_enabled: bool = False) -> "CoffeeDiaryStore":
        return cls(coffee_diary_store_path(), writes_enabled=writes_enabled)

    def _read_document(self) -> CoffeeDiaryDocument:
        if not self.path.exists():
            return _empty_document()
        try:
            if self.path.stat().st_size > MAX_FILE_BYTES:
                raise CoffeeDiaryStoreUnavailable("coffee_diary_store_oversized")
            raw_bytes = self.path.read_bytes()
            if raw_bytes.startswith(b"\xef\xbb\xbf"):
                raise CoffeeDiaryStoreUnavailable()
            raw = json.loads(raw_bytes.decode("utf-8"))
            if not isinstance(raw, dict):
                raise CoffeeDiaryStoreUnavailable()
            # JSON validation intentionally parses UUID strings from the
            # canonical wire representation while retaining strict scalar
            # validation for all fields.
            document = CoffeeDiaryDocument.model_validate_json(raw_bytes)
            canonical = document.model_dump(mode="json")
            if canonical != raw:
                raise CoffeeDiaryStoreUnavailable("coffee_diary_store_not_canonical")
            return document
        except CoffeeDiaryStoreUnavailable:
            raise
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise CoffeeDiaryStoreUnavailable() from exc

    def _write_document(self, document: CoffeeDiaryDocument) -> None:
        encoded = _json_bytes(document.model_dump(mode="json"))
        if len(encoded) > MAX_FILE_BYTES:
            raise CoffeeDiaryValidationError("coffee_diary_store_oversized")
        parent = self.path.parent
        temporary: Optional[Path] = None
        try:
            parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="wb", prefix=f".{self.path.name}.", suffix=".tmp", dir=parent, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            temporary = None
            if os.name != "nt":
                directory_fd = os.open(parent, os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        except OSError as exc:
            raise CoffeeDiaryStoreUnavailable("coffee_diary_store_write_failed") from exc
        finally:
            if temporary is not None:
                try:
                    temporary.unlink()
                except OSError:
                    pass

    def read_document(self) -> CoffeeDiaryDocument:
        with self._thread_lock:
            return self._read_document()

    def collection(self) -> CoffeeDiaryCollection:
        document = self.read_document()
        beans = [bean for bean in document.beans if bean.deletedAt is None]
        active_extractions = [extraction for extraction in document.extractions if extraction.deletedAt is None]
        active_extractions.sort(key=lambda extraction: extraction.brewedAt, reverse=True)
        return CoffeeDiaryCollection(
            schemaVersion=SCHEMA_VERSION,
            revision=document.revision,
            updatedAt=document.updatedAt,
            beans=beans[:MAX_COLLECTION_BEANS],
            recentExtractions=active_extractions[:MAX_COLLECTION_EXTRACTIONS],
            photos=[photo for photo in document.photos if photo.deletedAt is None][:MAX_PHOTOS],
            beanCount=len(beans),
            extractionCount=len(active_extractions),
        )

    def bean_detail(self, bean_id: UUID) -> CoffeeDiaryBeanDetail:
        document = self.read_document()
        bean = next((candidate for candidate in document.beans if candidate.id == bean_id and candidate.deletedAt is None), None)
        if bean is None:
            raise CoffeeDiaryNotFound("coffee_diary_bean_not_found")
        extractions = [candidate for candidate in document.extractions if candidate.beanId == bean_id and candidate.deletedAt is None]
        extractions.sort(key=lambda extraction: extraction.brewedAt, reverse=True)
        return CoffeeDiaryBeanDetail(bean=bean, extractions=extractions[:MAX_COLLECTION_EXTRACTIONS])

    def _mutate(self, operation):
        with self._thread_lock:
            with _file_lock(self.path):
                if not self.writes_enabled:
                    raise CoffeeDiaryValidationError("coffee_diary_write_disabled")
                document = self._read_document()
                result, next_document = operation(document)
                self._write_document(next_document)
                return result

    @staticmethod
    def _idempotency_hash(operation: str, payload: BaseModel, *, bean_id: UUID | None = None) -> str:
        identity: dict[str, Any] = {"operation": operation, "payload": payload.model_dump(mode="json")}
        if bean_id is not None:
            identity["beanId"] = str(bean_id)
        return hashlib.sha256(_json_bytes(identity)).hexdigest()

    @staticmethod
    def _replay(
        document: CoffeeDiaryDocument,
        *,
        operation: str,
        key: str,
        request_hash: str,
        bean_id: UUID | None = None,
    ) -> Optional[BaseModel]:
        record = next((entry for entry in document.idempotency if entry.operation == operation and entry.key == key), None)
        if record is None:
            return None
        if operation == "bean.create":
            resource = next((candidate for candidate in document.beans if candidate.id == record.resourceId), None)
        else:
            resource = next((candidate for candidate in document.extractions if candidate.id == record.resourceId), None)
            if resource is None or bean_id is None or resource.beanId != bean_id:
                raise CoffeeDiaryConflict("coffee_diary_idempotency_key_reused")
        if record.requestHash != request_hash:
            raise CoffeeDiaryConflict("coffee_diary_idempotency_key_reused")
        if resource is None:
            raise CoffeeDiaryConflict("coffee_diary_idempotency_key_reused")
        return resource

    def create_bean(self, payload: CoffeeDiaryBeanCreate, idempotency_key: str) -> CoffeeDiaryBean:
        if not _IDEMPOTENCY_PATTERN.fullmatch(idempotency_key):
            raise CoffeeDiaryValidationError("idempotency_key_invalid")
        request_hash = self._idempotency_hash("bean.create", payload)

        def operation(document: CoffeeDiaryDocument):
            replay = self._replay(document, operation="bean.create", key=idempotency_key, request_hash=request_hash)
            if replay is not None:
                return replay, document
            if len(document.beans) >= MAX_BEANS:
                raise CoffeeDiaryValidationError("coffee_diary_too_many_beans")
            now = _canonical_now()
            bean = CoffeeDiaryBean(
                id=uuid4(), version=1, **payload.model_dump(), favoriteExtractionId=None, photoIds=[],
                createdAt=now, updatedAt=now,
            )
            next_idempotency = [*document.idempotency, CoffeeDiaryIdempotencyRecord(key=idempotency_key, operation="bean.create", requestHash=request_hash, resourceId=bean.id)]
            next_idempotency = next_idempotency[-MAX_IDEMPOTENCY_RECORDS:]
            next_document = document.model_copy(update={"revision": document.revision + 1, "updatedAt": now, "beans": [*document.beans, bean], "idempotency": next_idempotency})
            return bean, next_document

        return self._mutate(operation)

    def patch_bean(self, bean_id: UUID, payload: CoffeeDiaryBeanPatch, expected_version: int) -> CoffeeDiaryBean:
        def operation(document: CoffeeDiaryDocument):
            index = next((index for index, bean in enumerate(document.beans) if bean.id == bean_id), None)
            if index is None or document.beans[index].deletedAt is not None:
                raise CoffeeDiaryNotFound("coffee_diary_bean_not_found")
            current = document.beans[index]
            if current.version != expected_version:
                raise CoffeeDiaryConflict("revision_conflict")
            fields = {
                field: getattr(payload, field)
                for field in payload.model_fields_set
            }
            updated = CoffeeDiaryBean.model_validate({
                **current.model_dump(),
                **fields,
                "version": current.version + 1,
                "updatedAt": _canonical_now(),
            })
            next_beans = [*document.beans]
            next_beans[index] = updated
            next_document = document.model_copy(update={"revision": document.revision + 1, "updatedAt": updated.updatedAt, "beans": next_beans})
            return updated, next_document

        return self._mutate(operation)

    def set_favorite_extraction(self, bean_id: UUID, extraction_id: UUID | None, expected_version: int) -> CoffeeDiaryBean:
        def operation(document: CoffeeDiaryDocument):
            bean_index = next((index for index, bean in enumerate(document.beans) if bean.id == bean_id), None)
            if bean_index is None or document.beans[bean_index].deletedAt is not None:
                raise CoffeeDiaryNotFound("coffee_diary_bean_not_found")
            current = document.beans[bean_index]
            if current.version != expected_version:
                raise CoffeeDiaryConflict("revision_conflict")
            if extraction_id is not None:
                extraction = next((candidate for candidate in document.extractions if candidate.id == extraction_id and candidate.deletedAt is None), None)
                if extraction is None:
                    raise CoffeeDiaryNotFound("coffee_diary_extraction_not_found")
                if extraction.beanId != bean_id:
                    raise CoffeeDiaryValidationError("coffee_diary_extraction_belongs_to_another_bean")
            if current.favoriteExtractionId == extraction_id:
                return current, document
            now = _canonical_now()
            updated = current.model_copy(update={
                "version": current.version + 1,
                "favoriteExtractionId": extraction_id,
                "updatedAt": now,
            })
            next_beans = [*document.beans]
            next_beans[bean_index] = updated
            next_document = document.model_copy(update={"revision": document.revision + 1, "updatedAt": now, "beans": next_beans})
            return updated, next_document

        return self._mutate(operation)

    def delete_bean(self, bean_id: UUID, expected_version: int) -> CoffeeDiaryBean:
        def operation(document: CoffeeDiaryDocument):
            index = next((index for index, bean in enumerate(document.beans) if bean.id == bean_id), None)
            if index is None or document.beans[index].deletedAt is not None:
                raise CoffeeDiaryNotFound("coffee_diary_bean_not_found")
            current = document.beans[index]
            if current.version != expected_version:
                raise CoffeeDiaryConflict("revision_conflict")
            now = _canonical_now()
            deleted = current.model_copy(update={"version": current.version + 1, "updatedAt": now, "deletedAt": now})
            next_beans = [*document.beans]
            next_beans[index] = deleted
            next_document = document.model_copy(update={"revision": document.revision + 1, "updatedAt": now, "beans": next_beans})
            return deleted, next_document

        return self._mutate(operation)

    def create_extraction(self, bean_id: UUID, payload: CoffeeDiaryExtractionCreate, idempotency_key: str) -> CoffeeDiaryExtraction:
        if not _IDEMPOTENCY_PATTERN.fullmatch(idempotency_key):
            raise CoffeeDiaryValidationError("idempotency_key_invalid")
        request_hash = self._idempotency_hash("extraction.create", payload, bean_id=bean_id)

        def operation(document: CoffeeDiaryDocument):
            replay = self._replay(
                document,
                operation="extraction.create",
                key=idempotency_key,
                request_hash=request_hash,
                bean_id=bean_id,
            )
            if replay is not None:
                return replay, document
            bean = next((candidate for candidate in document.beans if candidate.id == bean_id and candidate.deletedAt is None), None)
            if bean is None:
                raise CoffeeDiaryNotFound("coffee_diary_bean_not_found")
            if len(document.extractions) >= MAX_EXTRACTIONS:
                raise CoffeeDiaryValidationError("coffee_diary_too_many_extractions")
            now = _canonical_now()
            extraction = CoffeeDiaryExtraction(
                id=uuid4(), version=1, beanId=bean_id,
                **payload.model_dump(exclude={"makeFavorite"}), createdAt=now, updatedAt=now,
            )
            next_idempotency = [*document.idempotency, CoffeeDiaryIdempotencyRecord(key=idempotency_key, operation="extraction.create", requestHash=request_hash, resourceId=extraction.id)]
            next_idempotency = next_idempotency[-MAX_IDEMPOTENCY_RECORDS:]
            next_beans = [*document.beans]
            if payload.makeFavorite:
                bean_index = next(index for index, candidate in enumerate(next_beans) if candidate.id == bean_id)
                next_beans[bean_index] = bean.model_copy(update={
                    "version": bean.version + 1,
                    "favoriteExtractionId": extraction.id,
                    "updatedAt": now,
                })
            next_document = document.model_copy(update={
                "revision": document.revision + 1,
                "updatedAt": now,
                "beans": next_beans,
                "extractions": [*document.extractions, extraction],
                "idempotency": next_idempotency,
            })
            return extraction, next_document

        return self._mutate(operation)

    def delete_extraction(self, extraction_id: UUID, expected_version: int) -> CoffeeDiaryExtraction:
        def operation(document: CoffeeDiaryDocument):
            index = next((index for index, extraction in enumerate(document.extractions) if extraction.id == extraction_id), None)
            if index is None or document.extractions[index].deletedAt is not None:
                raise CoffeeDiaryNotFound("coffee_diary_extraction_not_found")
            current = document.extractions[index]
            if current.version != expected_version:
                raise CoffeeDiaryConflict("revision_conflict")
            now = _canonical_now()
            deleted = current.model_copy(update={"version": current.version + 1, "updatedAt": now, "deletedAt": now})
            next_extractions = [*document.extractions]
            next_extractions[index] = deleted
            next_beans = [*document.beans]
            bean_index = next((index for index, bean in enumerate(next_beans) if bean.id == current.beanId), None)
            if bean_index is not None and next_beans[bean_index].favoriteExtractionId == extraction_id:
                bean = next_beans[bean_index]
                next_beans[bean_index] = bean.model_copy(update={
                    "version": bean.version + 1,
                    "favoriteExtractionId": None,
                    "updatedAt": now,
                })
            next_document = document.model_copy(update={
                "revision": document.revision + 1,
                "updatedAt": now,
                "beans": next_beans,
                "extractions": next_extractions,
            })
            return deleted, next_document

        return self._mutate(operation)

    def export(self) -> CoffeeDiaryExport:
        document = self.read_document()
        return CoffeeDiaryExport(
            schemaVersion=EXPORT_SCHEMA_VERSION,
            sourceSchemaVersion=SCHEMA_VERSION,
            revision=document.revision,
            updatedAt=document.updatedAt,
            beans=deepcopy(document.beans),
            extractions=deepcopy(document.extractions),
            photos=deepcopy(document.photos),
        )

    def export_bytes(self) -> bytes:
        return _json_bytes(self.export().model_dump(mode="json"))


def validate_idempotency_key(value: Optional[str]) -> str:
    if value is None:
        raise CoffeeDiaryValidationError("idempotency_key_required")
    candidate = value.strip()
    if not _IDEMPOTENCY_PATTERN.fullmatch(candidate):
        raise CoffeeDiaryValidationError("idempotency_key_invalid")
    return candidate


def validate_if_match(value: Optional[str]) -> int:
    if value is None:
        raise CoffeeDiaryValidationError("if_match_required")
    candidate = value.strip()
    if len(candidate) >= 2 and candidate[0] == '"' and candidate[-1] == '"':
        candidate = candidate[1:-1]
    if not candidate.isdigit():
        raise CoffeeDiaryValidationError("if_match_invalid")
    parsed = int(candidate)
    if parsed < 1:
        raise CoffeeDiaryValidationError("if_match_invalid")
    return parsed


def validate_uuid4(value: str) -> UUID4:
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as exc:
        raise CoffeeDiaryValidationError("coffee_diary_id_invalid") from exc
    if parsed.version != 4:
        raise CoffeeDiaryValidationError("coffee_diary_id_invalid")
    return parsed  # type: ignore[return-value]
