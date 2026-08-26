"""Bounded owner capability registry and durable override store.

This module deliberately knows about a small product allowlist.  It is not an
environment editor: neither request payloads nor persisted data contain an
environment variable name, command, path, or build argument.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Literal, Mapping


CapabilityBehavior = Literal["immediate", "delayed"]
ApplyRequirement = Literal["none", "restart", "rebuild"]

SCHEMA_VERSION = "capability-overrides.v1"
MAX_FILE_BYTES = 16 * 1024

IMMEDIATE_MUTABLE_IDS = frozenset({"calendar_display_colors", "overview_layout_editor"})
DELAYED_MUTABLE_IDS = frozenset({
    "planning_overview",
    "planning_tasks_route",
    "planning_calendar_route",
    "planning_reminders_route",
})
MUTABLE_IDS = IMMEDIATE_MUTABLE_IDS | DELAYED_MUTABLE_IDS


@dataclass(frozen=True)
class CapabilityDefinition:
    id: str
    label: str
    description: str
    group: str
    technical_flag: str
    behavior: CapabilityBehavior
    apply_requirement: ApplyRequirement
    mutable: bool = False


# This is a deliberately explicit owner-facing classification.  It is not
# generated from IntegrationSettings or the build environment: adding a new
# product gate must make a maintainer decide whether it belongs in this safe
# inventory (and update the completeness test), rather than silently exposing
# a new switch or configuration detail.
#
# Read-only entries are context, not an invitation to edit deployment,
# infrastructure, or security configuration.
CAPABILITY_REGISTRY: tuple[CapabilityDefinition, ...] = (
    CapabilityDefinition("calendar_display_colors", "Изменение цветов календарей", "Цвета действуют только внутри панели.", "Локальные возможности", "PANEL_CALENDAR_DISPLAY_COLOR_WRITES_ENABLED", "immediate", "none", True),
    CapabilityDefinition("overview_layout_editor", "Редактирование главного экрана", "Позволяет менять расположение виджетов на главном экране.", "Локальные возможности", "PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED", "immediate", "none", True),
    CapabilityDefinition("planning_overview", "Обзор планирования", "Карточка планирования на главном экране.", "Планирование", "VITE_PLANNING_OVERVIEW_ENABLED", "delayed", "rebuild", True),
    CapabilityDefinition("planning_tasks_route", "Раздел «Задачи»", "Доступность раздела задач в панели.", "Планирование", "VITE_PLANNING_TASKS_ROUTE_ENABLED", "delayed", "rebuild", True),
    CapabilityDefinition("planning_calendar_route", "Раздел «Календарь»", "Доступность раздела календаря в панели.", "Планирование", "VITE_PLANNING_CALENDAR_ROUTE_ENABLED", "delayed", "rebuild", True),
    CapabilityDefinition("planning_reminders_route", "Раздел «Напоминания»", "Доступность раздела напоминаний в панели.", "Планирование", "VITE_PLANNING_REMINDERS_ROUTE_ENABLED", "delayed", "rebuild", True),
    CapabilityDefinition("v2_visual_shell", "Новая оболочка панели", "Основная оболочка интерфейса.", "Интерфейс", "VITE_V2_VISUAL_SHELL", "delayed", "rebuild"),
    CapabilityDefinition("overview_v2", "Главный экран V2", "Базовая версия главного экрана.", "Интерфейс", "VITE_OVERVIEW_V2_ENABLED", "delayed", "rebuild"),
    CapabilityDefinition("overview_editor_ui", "Поддержка редактора главного экрана", "Сборка интерфейса редактора главного экрана.", "Интерфейс", "VITE_OVERVIEW_EDITOR_ENABLED", "delayed", "rebuild"),
    CapabilityDefinition("planning_reminder_mutations_ui", "Поддержка изменения напоминаний", "Сборка интерфейса для изменения напоминаний.", "Планирование", "VITE_PLANNING_REMINDER_MUTATIONS_ENABLED", "delayed", "rebuild"),
    CapabilityDefinition("planning_task_mutations_ui", "Поддержка изменения задач", "Сборка интерфейса для изменения задач.", "Планирование", "VITE_PLANNING_TASK_MUTATIONS_ENABLED", "delayed", "rebuild"),
    CapabilityDefinition("planning_calendar_mutations_ui", "Поддержка изменения календаря", "Сборка интерфейса для изменения событий календаря.", "Планирование", "VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED", "delayed", "rebuild"),
    CapabilityDefinition("touch_lock", "Блокировка сенсорного ввода", "Поддержка защиты от случайных касаний.", "Системные действия", "VITE_TOUCH_INPUT_LOCK_ENABLED", "delayed", "rebuild"),
    CapabilityDefinition("touch_lock_start_locked", "Начальная блокировка сенсорного ввода", "Панель запускается заблокированной.", "Системные действия", "VITE_TOUCH_INPUT_LOCK_START_LOCKED", "delayed", "rebuild"),
    CapabilityDefinition("planning_integration", "Интеграция планирования", "Подключение панели к сервису планирования.", "Планирование", "PANEL_PLANNING_ENABLED", "immediate", "none"),
    CapabilityDefinition("ai_text", "Текстовый AI", "Провайдер-нейтральный текстовый слой для кратких ответов.", "AI", "PANEL_AI_TEXT_ENABLED", "immediate", "none"),
    CapabilityDefinition("ai_provider_settings", "Настройки AI-провайдеров", "Разрешение менять выбранного провайдера и его серверный секрет.", "AI", "PANEL_AI_SETTINGS_WRITES_ENABLED", "immediate", "none"),
    CapabilityDefinition("ai_local_fallback", "Локальный AI fallback", "Фиксированная локальная текстовая модель при сбое выбранного провайдера.", "AI", "PANEL_AI_LOCAL_ENABLED", "immediate", "none"),
    CapabilityDefinition("planning_reminder_mutations", "Запись напоминаний", "Разрешение Panel Agent изменять напоминания.", "Планирование", "PANEL_PLANNING_REMINDER_MUTATIONS_ENABLED", "immediate", "none"),
    CapabilityDefinition("planning_task_mutations", "Запись задач", "Разрешение Panel Agent изменять задачи.", "Планирование", "PANEL_PLANNING_TASK_MUTATIONS_ENABLED", "immediate", "none"),
    CapabilityDefinition("planning_calendar_mutations", "Запись календаря", "Разрешение Panel Agent изменять события календаря.", "Планирование", "PANEL_PLANNING_CALENDAR_MUTATIONS_ENABLED", "immediate", "none"),
    CapabilityDefinition("panel_writes", "Запись панели", "Главный защитный барьер для всех операций записи.", "Системные действия", "PANEL_WRITES_ENABLED", "immediate", "none"),
    CapabilityDefinition("coffee_timing_writes", "Запись времени кофемашины", "Разрешение менять расписание кофемашины.", "Системные действия", "PANEL_COFFEE_TIMING_WRITES_ENABLED", "immediate", "none"),
    CapabilityDefinition("coffee_notification_writes", "Запись уведомлений кофемашины", "Разрешение менять уведомления кофемашины.", "Системные действия", "PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED", "immediate", "none"),
    CapabilityDefinition("coffee_actions", "Действия кофемашины", "Разрешение выполнять действия кофемашины.", "Системные действия", "PANEL_COFFEE_ACTIONS_ENABLED", "immediate", "none"),
    CapabilityDefinition("avalar_ssh", "Статус AVALAR по SSH", "Получение состояния инфраструктуры AVALAR.", "Инфраструктура", "PANEL_AVALAR_SSH_ENABLED", "immediate", "none"),
    CapabilityDefinition("avalar_actions", "Действия AVALAR", "Инфраструктурные действия внешнего сервиса.", "Инфраструктура", "PANEL_AVALAR_ACTIONS_ENABLED", "immediate", "none"),
    CapabilityDefinition("avalar_smoke", "Проверка AVALAR", "Smoke-проверка инфраструктуры AVALAR.", "Инфраструктура", "PANEL_AVALAR_SMOKE_ENABLED", "immediate", "none"),
    CapabilityDefinition("avalar_stage_restart", "Перезапуск AVALAR Stage", "Инфраструктурное разрешение перезапуска Stage.", "Инфраструктура", "PANEL_AVALAR_STAGE_RESTART_ENABLED", "immediate", "none"),
    CapabilityDefinition("avalar_main_restart", "Перезапуск AVALAR Main", "Инфраструктурное разрешение перезапуска Main.", "Инфраструктура", "PANEL_AVALAR_MAIN_RESTART_ENABLED", "immediate", "none"),
    CapabilityDefinition("avalar_stage_deploy", "Развёртывание AVALAR Stage", "Инфраструктурное разрешение развёртывания Stage.", "Инфраструктура", "PANEL_AVALAR_STAGE_DEPLOY_ENABLED", "immediate", "none"),
    CapabilityDefinition("avalar_main_deploy", "Развёртывание AVALAR Main", "Инфраструктурное разрешение развёртывания Main.", "Инфраструктура", "PANEL_AVALAR_MAIN_DEPLOY_ENABLED", "immediate", "none"),
    CapabilityDefinition("rog_g703", "Инфраструктура ROG G703", "Управление зарегистрированной инфраструктурой ROG.", "Инфраструктура", "PANEL_ROG_G703_ENABLED", "immediate", "none"),
    CapabilityDefinition("kiosk_controls", "Управление киоском", "Разрешение владельцу скрывать или останавливать киоск панели.", "Системные действия", "PANEL_KIOSK_CONTROLS_ENABLED", "immediate", "none"),
    CapabilityDefinition("panel_update_controls", "Обновление панели", "Разрешение проверять и устанавливать обновление самой панели через фиксированный системный механизм.", "Системные действия", "PANEL_UPDATE_CONTROLS_ENABLED", "immediate", "none"),
)
REGISTRY_BY_ID = {entry.id: entry for entry in CAPABILITY_REGISTRY}


class CapabilityStoreError(ValueError):
    pass


class CapabilityRevisionConflict(CapabilityStoreError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def capability_store_path() -> Path:
    configured = os.getenv("PANEL_CAPABILITY_OVERRIDES_PATH", "").strip()
    if configured:
        return Path(configured)
    root = Path(os.getenv("LOCALAPPDATA", "") or Path.cwd() / ".runtime") / "ArtemControlCenter"
    return root / "capability-overrides.json"


class CapabilityOverrideStore:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else capability_store_path()
        self._write_lock = Lock()

    def _empty(self) -> dict[str, Any]:
        return {"schemaVersion": SCHEMA_VERSION, "revision": 0, "updatedAt": utc_now(), "overrides": {}}

    def _read_raw(self) -> Mapping[str, Any] | None:
        if not self.path.exists():
            return self._empty()
        try:
            if self.path.stat().st_size > MAX_FILE_BYTES:
                return None
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return raw if isinstance(raw, dict) else None
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _canonical(self, raw: Mapping[str, Any] | None) -> dict[str, Any] | None:
        if raw is None or raw.get("schemaVersion") != SCHEMA_VERSION:
            return None
        revision, updated_at, overrides = raw.get("revision"), raw.get("updatedAt"), raw.get("overrides")
        if type(revision) is not int or revision < 0 or not isinstance(updated_at, str) or not isinstance(overrides, dict):
            return None
        if set(overrides) - MUTABLE_IDS or any(type(value) is not bool for value in overrides.values()):
            return None
        return {"schemaVersion": SCHEMA_VERSION, "revision": revision, "updatedAt": updated_at, "overrides": dict(sorted(overrides.items()))}

    def read(self) -> tuple[dict[str, Any], bool]:
        canonical = self._canonical(self._read_raw())
        return (canonical, True) if canonical is not None else (self._empty(), False)

    def write(self, *, capability_id: str, enabled: bool | None, expected_revision: int) -> tuple[dict[str, Any], bool]:
        if capability_id not in MUTABLE_IDS:
            raise CapabilityStoreError("capability_not_mutable")
        with self._write_lock:
            current, available = self.read()
            if not available:
                raise CapabilityStoreError("capability_store_unavailable")
            if current["revision"] != expected_revision:
                raise CapabilityRevisionConflict("revision_conflict")
            overrides = dict(current["overrides"])
            if enabled is None:
                overrides.pop(capability_id, None)
            else:
                overrides[capability_id] = enabled
            document = {"schemaVersion": SCHEMA_VERSION, "revision": expected_revision + 1, "updatedAt": utc_now(), "overrides": dict(sorted(overrides.items()))}
            self._atomic_write(document)
            return document, True

    def _atomic_write(self, document: Mapping[str, Any]) -> None:
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise CapabilityStoreError("capability_store_too_large")
        temporary: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="wb", prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
