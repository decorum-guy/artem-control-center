from __future__ import annotations

import os
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field


KNOWLEDGE_SCHEMA_VERSION = "knowledge.document.v1"
COFFEE_GUIDE_DOCUMENT_ID = "coffee-guide"
COFFEE_GUIDE_FILENAME = "coffee-guide.md"
MAX_DOCUMENT_BYTES = 64 * 1024

KnowledgeStatus = Literal[
    "available",
    "missing",
    "invalid_utf8",
    "too_large",
    "unavailable",
]


class KnowledgeDocument(BaseModel):
    """The bounded, server-owned result returned for a knowledge document."""

    model_config = ConfigDict(populate_by_name=True)

    schema_version: Literal["knowledge.document.v1"] = Field(alias="schemaVersion")
    document_id: Literal["coffee-guide"] = Field(alias="documentId")
    status: KnowledgeStatus
    content: Optional[str]
    byte_size: Optional[int] = Field(alias="byteSize")
    modified_at: Optional[str] = Field(alias="modifiedAt")


def resolve_knowledge_root() -> Path | None:
    """Resolve the production knowledge root from the Windows runtime contract.

    A missing or relative LOCALAPPDATA is deliberately not replaced with the
    repository working directory. Callers can inject a trusted absolute root
    into KnowledgeReader for deterministic tests.
    """

    local_app_data = os.getenv("LOCALAPPDATA", "").strip()
    if not local_app_data:
        return None
    root = Path(local_app_data)
    if not root.is_absolute():
        return None
    return root / "ArtemControlCenter" / "knowledge"


class KnowledgeReader:
    """Read the one fixed owner-maintained knowledge document.

    The public reader API intentionally has no caller-supplied path, filename,
    or document selector. The optional constructor root is trusted server
    configuration used for tests, never an HTTP or browser input.
    """

    def __init__(self, knowledge_root: Path | str | None = None) -> None:
        self._knowledge_root = Path(knowledge_root) if knowledge_root is not None else None

    def read_coffee_guide(self) -> KnowledgeDocument:
        root = self._knowledge_root or resolve_knowledge_root()
        if root is None:
            return self._unavailable()

        try:
            root_lstat = os.lstat(root)
            if stat.S_ISLNK(root_lstat.st_mode) or not stat.S_ISDIR(root_lstat.st_mode):
                return self._unavailable()
            resolved_root = root.resolve(strict=True)
            resolved_root_stat = os.stat(resolved_root)
            if not stat.S_ISDIR(resolved_root_stat.st_mode):
                return self._unavailable()
        except (OSError, RuntimeError, ValueError):
            return self._unavailable()

        # The filename is a source-controlled constant. No caller-controlled
        # path is joined, normalized, or sanitized here.
        document_path = resolved_root / COFFEE_GUIDE_FILENAME
        try:
            document_lstat = os.lstat(document_path)
        except FileNotFoundError:
            return self._missing()
        except OSError:
            return self._unavailable()

        # Reject links and every non-regular type before opening anything. The
        # resolved containment check also protects against unexpected
        # intermediate links in a trusted root.
        if stat.S_ISLNK(document_lstat.st_mode) or not stat.S_ISREG(document_lstat.st_mode):
            return self._unavailable()
        if self._file_identity(document_lstat) is None:
            return self._unavailable()
        try:
            resolved_document = document_path.resolve(strict=True)
            resolved_document.relative_to(resolved_root)
        except (OSError, RuntimeError, ValueError):
            return self._unavailable()

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        file_descriptor: int | None = None
        try:
            file_descriptor = os.open(str(resolved_document), flags)
            with os.fdopen(file_descriptor, "rb") as handle:
                file_descriptor = None
                metadata = os.fstat(handle.fileno())
                if not self._same_regular_file(document_lstat, metadata):
                    return self._unavailable()
                try:
                    post_open_lstat = os.lstat(document_path)
                except OSError:
                    return self._unavailable()
                if not self._same_regular_file(document_lstat, post_open_lstat):
                    return self._unavailable()
                raw_content = handle.read(MAX_DOCUMENT_BYTES + 1)
        except FileNotFoundError:
            # The fixed path existed during validation but disappeared before
            # open. Treat that check/open race as unavailable; a later request
            # will perform a fresh validation and can report missing normally.
            return self._unavailable()
        except (OSError, ValueError):
            return self._unavailable()
        finally:
            if file_descriptor is not None:
                try:
                    os.close(file_descriptor)
                except OSError:
                    pass

        if len(raw_content) > MAX_DOCUMENT_BYTES:
            return self._too_large()

        try:
            content = raw_content.decode("utf-8-sig")
        except UnicodeDecodeError:
            return self._invalid_utf8()

        return KnowledgeDocument(
            schema_version=KNOWLEDGE_SCHEMA_VERSION,
            document_id=COFFEE_GUIDE_DOCUMENT_ID,
            status="available",
            content=content,
            byte_size=len(raw_content),
            modified_at=self._modified_at(metadata.st_mtime),
        )

    @staticmethod
    def _file_identity(metadata: os.stat_result) -> tuple[int, int] | None:
        """Return the cross-platform identity fields for a validated file.

        Python exposes the device and file-index/inode pair as ``st_dev`` and
        ``st_ino`` on supported POSIX and Windows runtimes. If either field is
        unavailable or unusable, the safe result is to reject the read rather
        than treat a pathname as an object binding.
        """

        try:
            device = int(metadata.st_dev)
            inode = int(metadata.st_ino)
        except (AttributeError, TypeError, ValueError):
            return None
        if device <= 0 or inode <= 0:
            return None
        return device, inode

    @classmethod
    def _same_regular_file(
        cls,
        expected: os.stat_result,
        actual: os.stat_result,
    ) -> bool:
        if not stat.S_ISREG(expected.st_mode) or not stat.S_ISREG(actual.st_mode):
            return False
        expected_identity = cls._file_identity(expected)
        actual_identity = cls._file_identity(actual)
        return expected_identity is not None and expected_identity == actual_identity

    @staticmethod
    def _modified_at(timestamp: float) -> str | None:
        try:
            return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace(
                "+00:00",
                "Z",
            )
        except (OverflowError, OSError, ValueError):
            return None

    @staticmethod
    def _document(
        status: KnowledgeStatus,
        *,
        content: str | None = None,
        byte_size: int | None = None,
        modified_at: str | None = None,
    ) -> KnowledgeDocument:
        return KnowledgeDocument(
            schema_version=KNOWLEDGE_SCHEMA_VERSION,
            document_id=COFFEE_GUIDE_DOCUMENT_ID,
            status=status,
            content=content,
            byte_size=byte_size,
            modified_at=modified_at,
        )

    @classmethod
    def _unavailable(cls) -> KnowledgeDocument:
        return cls._document("unavailable")

    @classmethod
    def _missing(cls) -> KnowledgeDocument:
        return cls._document("missing")

    @classmethod
    def _invalid_utf8(cls) -> KnowledgeDocument:
        return cls._document("invalid_utf8")

    @classmethod
    def _too_large(cls) -> KnowledgeDocument:
        return cls._document("too_large")


def build_knowledge_router(reader: KnowledgeReader) -> APIRouter:
    router = APIRouter()

    @router.get(
        "/api/v1/knowledge/coffee-guide",
        response_model=KnowledgeDocument,
    )
    def get_coffee_guide(request: Request, response: Response) -> KnowledgeDocument:
        response.headers["Cache-Control"] = "no-store"
        if request.query_params:
            raise HTTPException(status_code=400, detail="knowledge_query_not_supported")
        return reader.read_coffee_guide()

    return router
