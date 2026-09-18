"""Closed, deterministic interpretation boundary for Jarvis A1.

This module intentionally has no network, shell, Home Assistant, provider, or
action-execution dependency.  Future STT must submit text through this same
bounded classifier and turn contract.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field


JARVIS_INTENT_SCHEMA_VERSION = "jarvis.intent.v1"
MAX_JARVIS_TEXT_CODEPOINTS = 512

IntentId = Literal[
    "system.time.current", "weather.read", "planning.calendar.read",
    "planning.tasks.read", "planning.reminders.read", "navigation.overview",
    "navigation.calendar", "navigation.tasks", "navigation.reminders",
    "navigation.settings", "navigation.system", "navigation.coffee_diary",
    "jarvis.repeat", "jarvis.cancel", "jarvis.stop", "home.coffee.turn_on",
    "general.question",
]
IntentKind = Literal["read", "navigation", "conversation", "future_mutation", "fallback"]
ConfidenceClass = Literal["exact", "strong", "fallback"]


@dataclass(frozen=True)
class IntentDefinition:
    id: IntentId
    kind: IntentKind
    executable_in_a1: bool


INTENT_REGISTRY: Final[tuple[IntentDefinition, ...]] = (
    IntentDefinition("system.time.current", "read", True),
    IntentDefinition("weather.read", "read", True),
    IntentDefinition("planning.calendar.read", "read", True),
    IntentDefinition("planning.tasks.read", "read", True),
    IntentDefinition("planning.reminders.read", "read", True),
    IntentDefinition("navigation.overview", "navigation", True),
    IntentDefinition("navigation.calendar", "navigation", True),
    IntentDefinition("navigation.tasks", "navigation", True),
    IntentDefinition("navigation.reminders", "navigation", True),
    IntentDefinition("navigation.settings", "navigation", True),
    IntentDefinition("navigation.system", "navigation", True),
    IntentDefinition("navigation.coffee_diary", "navigation", True),
    IntentDefinition("jarvis.repeat", "conversation", True),
    IntentDefinition("jarvis.cancel", "conversation", True),
    IntentDefinition("jarvis.stop", "conversation", True),
    # Classification-only future concept.  It is never put in an executor map.
    IntentDefinition("home.coffee.turn_on", "future_mutation", False),
    IntentDefinition("general.question", "fallback", True),
)


class JarvisIntentSlots(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)


class JarvisIntentEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)

    schema_version: Literal["jarvis.intent.v1"] = Field(default=JARVIS_INTENT_SCHEMA_VERSION, alias="schemaVersion")
    intent_id: IntentId = Field(alias="intentId")
    kind: IntentKind
    confidence_class: ConfidenceClass = Field(alias="confidenceClass")
    normalized_text: str = Field(max_length=MAX_JARVIS_TEXT_CODEPOINTS, alias="normalizedText")
    slots: JarvisIntentSlots = Field(default_factory=JarvisIntentSlots)
    requires_confirmation: bool = Field(default=False, alias="requiresConfirmation")


def normalize_jarvis_text(text: str) -> str:
    """NFC/casefold Russian text and collapse punctuation/control whitespace."""

    normalized = unicodedata.normalize("NFC", text)
    characters = [
        " " if char.isspace() or unicodedata.category(char).startswith(("P", "C")) else char
        for char in normalized
    ]
    return " ".join("".join(characters).casefold().split())


def _matches(text: str, *phrases: str) -> bool:
    comparable = text.replace("ё", "е")
    return any(comparable == phrase.replace("ё", "е") for phrase in phrases)


def _contains(text: str, *terms: str) -> bool:
    comparable = text.replace("ё", "е")
    return all(term.replace("ё", "е") in comparable for term in terms)


def _envelope(intent_id: IntentId, kind: IntentKind, confidence: ConfidenceClass, text: str) -> JarvisIntentEnvelope:
    return JarvisIntentEnvelope(intentId=intent_id, kind=kind, confidenceClass=confidence, normalizedText=text)


def classify_jarvis_text(text: str) -> JarvisIntentEnvelope:
    """Fail closed to ``general.question``; client text can never choose an ID."""

    normalized = normalize_jarvis_text(text)
    # Wake/STT slices submit their recognized text here as well; accepting only
    # this harmless leading address keeps the turn boundary identical for typed
    # and spoken entry without turning it into a free-form prefix parser.
    if normalized.startswith("джарвис "):
        normalized = normalized.removeprefix("джарвис ")
    if _matches(normalized, "повтори", "повторить", "еще раз", "ещё раз"):
        return _envelope("jarvis.repeat", "conversation", "exact", normalized)
    if _matches(normalized, "отмена", "отмени", "отбой"):
        return _envelope("jarvis.cancel", "conversation", "exact", normalized)
    if _matches(normalized, "стоп", "остановись", "прекрати"):
        return _envelope("jarvis.stop", "conversation", "exact", normalized)
    if _matches(normalized, "который час", "сколько времени", "который сейчас час"):
        return _envelope("system.time.current", "read", "exact", normalized)
    if _matches(normalized, "погода", "какая погода", "что с погодой", "какая сегодня погода"):
        return _envelope("weather.read", "read", "exact", normalized)
    if _matches(normalized, "что у меня сегодня", "какие сегодня события", "что в календаре"):
        return _envelope("planning.calendar.read", "read", "exact", normalized)
    if _matches(normalized, "что по задачам", "какие у меня задачи", "покажи задачи"):
        return _envelope("planning.tasks.read", "read", "exact", normalized)
    if _matches(normalized, "какие напоминания", "какие у меня напоминания", "покажи напоминания"):
        return _envelope("planning.reminders.read", "read", "exact", normalized)

    navigation: tuple[tuple[IntentId, tuple[str, ...]], ...] = (
        ("navigation.overview", ("открой обзор", "открой главную", "покажи обзор")),
        ("navigation.calendar", ("открой календарь", "покажи календарь")),
        ("navigation.tasks", ("открой задачи", "покажи задачи")),
        ("navigation.reminders", ("открой напоминания", "покажи напоминания")),
        ("navigation.settings", ("открой настройки", "покажи настройки")),
        ("navigation.system", ("открой систему", "открой системные настройки")),
        ("navigation.coffee_diary", ("открой дневник кофе", "открой кофейный дневник")),
    )
    for intent_id, phrases in navigation:
        if _matches(normalized, *phrases):
            return _envelope(intent_id, "navigation", "exact", normalized)

    # Recognize this only so the owner gets a truthful refusal.  There is no
    # executor and no generic HA/action fallback in this slice.
    if (
        not re.search(r"\b(не|нельзя|никогда)\b", normalized)
        and _contains(normalized, "кофемашин")
        and re.search(r"\b(включи|запусти|вруби)\b", normalized)
    ):
        return _envelope("home.coffee.turn_on", "future_mutation", "strong", normalized)
    return _envelope("general.question", "fallback", "fallback", normalized)
