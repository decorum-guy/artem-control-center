"""Durable, narrow server-side AI provider settings and credentials.

The document is intentionally not an environment editor.  It stores only a
registered provider selection, a registered model selection and provider
credentials.  Public reads return metadata only; credentials never leave this
module after a write.
"""
from __future__ import annotations

import json
import os
import tempfile
import subprocess
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any, Mapping

SCHEMA_VERSION = "ai.provider-settings.v1"
MAX_FILE_BYTES = 64 * 1024
PROVIDER_IDS = ("gigachat", "yandex", "deepseek", "local")
MODELS = {
    "gigachat": ("GigaChat-2", "GigaChat-2-Pro", "GigaChat-2-Max"),
    "yandex": ("yandexgpt/latest",),
    "deepseek": ("deepseek-v4-flash", "deepseek-v4-pro"),
}

class AISettingsError(ValueError): pass
class AISettingsConflict(AISettingsError): pass

def _empty() -> dict[str, Any]:
    return {"schemaVersion": SCHEMA_VERSION, "revision": 0, "selectedProvider": "gigachat", "selectedModels": {key: values[0] for key, values in MODELS.items()}, "credentials": {}}

@dataclass(frozen=True)
class AISettingsSnapshot:
    revision: int
    selected_provider: str
    selected_models: dict[str, str]
    credentials: dict[str, str]

class AIProviderSettingsStore:
    def __init__(self, path: str) -> None:
        self.path = Path(path or ".cache/ai-provider-settings.json")
        self._lock = RLock()

    @classmethod
    def from_environment(cls) -> "AIProviderSettingsStore":
        root = Path(os.getenv("LOCALAPPDATA", "") or Path.cwd() / ".runtime") / "ArtemControlCenter"
        return cls(os.getenv("PANEL_AI_SETTINGS_PATH", "") or root / "ai-provider-settings.json")

    def _canonical(self, raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
        if not isinstance(raw, Mapping) or raw.get("schemaVersion") != SCHEMA_VERSION:
            return None
        revision, provider, models, credentials = raw.get("revision"), raw.get("selectedProvider"), raw.get("selectedModels"), raw.get("credentials")
        if not isinstance(revision, int) or revision < 0 or provider not in PROVIDER_IDS or not isinstance(models, Mapping) or not isinstance(credentials, Mapping): return None
        normalized_models: dict[str, str] = {}
        normalized_credentials: dict[str, str] = {}
        for provider_id, allowed in MODELS.items():
            model = models.get(provider_id, allowed[0])
            if model not in allowed: return None
            normalized_models[provider_id] = model
        for provider_id, secret in credentials.items():
            if provider_id not in PROVIDER_IDS or provider_id == "local" or not isinstance(secret, str) or not (1 <= len(secret) <= 8192): return None
            normalized_credentials[provider_id] = secret
        return {"schemaVersion": SCHEMA_VERSION, "revision": revision, "selectedProvider": provider, "selectedModels": normalized_models, "credentials": normalized_credentials}

    def _load(self) -> tuple[dict[str, Any], bool]:
        if not self.path.exists(): return _empty(), True
        try:
            if self.path.stat().st_size > MAX_FILE_BYTES: raise ValueError()
            value = self._canonical(json.loads(self.path.read_text(encoding="utf-8")))
            if value is None: raise ValueError()
            return value, True
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return _empty(), False

    def snapshot(self) -> tuple[AISettingsSnapshot, bool]:
        document, available = self._load()
        return AISettingsSnapshot(document["revision"], document["selectedProvider"], dict(document["selectedModels"]), dict(document["credentials"])), available

    def public(self, *, enabled: bool, writes_enabled: bool, local_enabled: bool, local_model: str, yandex_folder_configured: bool = False) -> dict[str, Any]:
        snapshot, available = self.snapshot()
        providers = []
        for provider_id in PROVIDER_IDS:
            credential_present = provider_id in snapshot.credentials
            configured = local_enabled if provider_id == "local" else (credential_present and (provider_id != "yandex" or yandex_folder_configured))
            state = "disabled" if not enabled else ("configured" if configured else "not_configured")
            if provider_id == "local":
                provider_model = local_model
                provider_models = [local_model] if local_model else []
            else:
                provider_model = snapshot.selected_models[provider_id]
                provider_models = list(MODELS[provider_id])
            providers.append({"id": provider_id, "model": provider_model, "models": provider_models, "credentialPresent": credential_present, "configured": configured, "state": state})
        return {"schemaVersion": SCHEMA_VERSION, "revision": snapshot.revision, "available": available, "enabled": enabled, "writesEnabled": writes_enabled, "selectedProvider": snapshot.selected_provider, "providers": providers, "warnings": [] if available else ["stored_settings_unavailable"]}

    def select(self, *, expected_revision: int, provider_id: str, model: str | None = None) -> None:
        if provider_id not in PROVIDER_IDS: raise AISettingsError("provider_or_model_unknown")
        if provider_id == "local":
            if model is not None: raise AISettingsError("provider_or_model_unknown")
        elif model not in MODELS[provider_id]:
            raise AISettingsError("provider_or_model_unknown")
        with self._lock:
            document, available = self._load()
            if not available: raise AISettingsError("stored_settings_unavailable")
            if document["revision"] != expected_revision: raise AISettingsConflict("revision_conflict")
            document["selectedProvider"] = provider_id
            if provider_id != "local":
                document["selectedModels"][provider_id] = model
            document["revision"] += 1
            self._write(document)

    def credential(self, *, expected_revision: int, provider_id: str, value: str | None) -> None:
        if provider_id not in PROVIDER_IDS or provider_id == "local": raise AISettingsError("credential_provider_unknown")
        if value is not None and not (1 <= len(value.strip()) <= 8192): raise AISettingsError("credential_invalid")
        with self._lock:
            document, available = self._load()
            if not available: raise AISettingsError("stored_settings_unavailable")
            if document["revision"] != expected_revision: raise AISettingsConflict("revision_conflict")
            if value is None: document["credentials"].pop(provider_id, None)
            else: document["credentials"][provider_id] = value.strip()
            document["revision"] += 1
            self._write(document)

    def _write(self, document: Mapping[str, Any]) -> None:
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        if len(encoded) > MAX_FILE_BYTES: raise AISettingsError("settings_too_large")
        temporary: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="wb", prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent, delete=False) as handle:
                temporary = Path(handle.name); handle.write(encoded); handle.flush(); os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            self._restrict_secret_file(temporary)
            os.replace(temporary, self.path)
            temporary = None
        finally:
            if temporary is not None:
                try: temporary.unlink(missing_ok=True)
                except OSError: pass

    @staticmethod
    def _restrict_secret_file(path: Path) -> None:
        """Apply the same owner/SYSTEM-only posture as runtime.env on Windows.

        This is a fixed OS permission call for this one known settings file,
        never a browser-controlled command or path.
        """
        if os.name != "nt":
            return
        account = os.getenv("USERNAME", "").strip()
        if not account:
            raise AISettingsError("secret_permissions_unavailable")
        completed = subprocess.run(
            ["icacls.exe", str(path), "/inheritance:r", "/grant:r", f"{account}:(F)", "*S-1-5-18:(F)"],
            capture_output=True,
            check=False,
            timeout=10,
        )
        if completed.returncode != 0:
            raise AISettingsError("secret_permissions_unavailable")
