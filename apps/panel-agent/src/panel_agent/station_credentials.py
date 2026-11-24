"""Windows current-user DPAPI storage for Station OAuth credentials."""

from __future__ import annotations

import ctypes
import json
from ctypes import wintypes
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

MAX_CREDENTIAL_BYTES = 16_384
ACCOUNT_KEYS = {"x_token", "music_client_id", "music_client_secret"}
MUSIC_KEYS = {"music_token", "expires_at"}


class _Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def dpapi(data: bytes, *, decrypt: bool) -> bytes:
    if not hasattr(ctypes, "windll"):
        raise OSError("Station credential storage requires Windows")
    source = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    incoming = _Blob(len(data), source)
    result = _Blob()
    crypt = ctypes.windll.crypt32
    method = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    # CRYPTPROTECT_UI_FORBIDDEN, without CRYPTPROTECT_LOCAL_MACHINE.
    if not method(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(result)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        free = ctypes.windll.kernel32.LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(result.data)


@dataclass(frozen=True)
class StationCredentials:
    x_token: str = field(default="", repr=False)
    music_client_id: str = field(default="", repr=False)
    music_client_secret: str = field(default="", repr=False)
    music_token: str = field(default="", repr=False)
    expires_at: datetime | None = None

    @classmethod
    def parse(cls, content: bytes) -> StationCredentials:
        values = json.loads(content)
        if not isinstance(values, dict) or values.keys() not in (ACCOUNT_KEYS, MUSIC_KEYS):
            raise ValueError("Invalid Station credential document")
        if not all(isinstance(value, str) and value and len(value) <= 4096 for value in values.values()):
            raise ValueError("Invalid Station credential fields")
        if values.keys() == MUSIC_KEYS:
            expires = datetime.fromisoformat(values["expires_at"])
            if expires.utcoffset() is None:
                raise ValueError("Station credential expiration needs a timezone")
            return cls(music_token=values["music_token"], expires_at=expires)
        return cls(**values)


class StationCredentialFile:
    def __init__(self, path: Path):
        self.path = path

    def version(self) -> tuple[int, int, int, int, int] | None:
        try:
            stat = self.path.stat()
            # Atomic replacement may preserve timestamps and length on Windows.
            return stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size
        except OSError:
            return None

    def read(self) -> StationCredentials:
        with self.path.open("rb") as file:
            value = file.read(MAX_CREDENTIAL_BYTES + 1)
        if not value or len(value) > MAX_CREDENTIAL_BYTES:
            raise ValueError("Invalid protected Station file")
        return StationCredentials.parse(dpapi(value, decrypt=True))
