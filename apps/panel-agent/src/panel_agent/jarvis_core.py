"""Deterministic, bounded Jarvis transcript classification.

This module is deliberately an interpretation boundary only.  It contains a
fixed intent registry and returns a typed envelope; it never authorizes or
executes an action, calls a provider, or talks to an integration.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Final, Literal, Sequence, Union

from pydantic import BaseModel, ConfigDict, Field


JARVIS_INTENT_SCHEMA_VERSION = "jarvis.intent.v1"
MAX_TRANSCRIPT_CODEPOINTS = 512
MAX_LOCATION_CODEPOINTS = 64

IntentId = Literal[
    "weather.read",
    "planning.calendar.read",
    "planning.tasks.read",
    "planning.reminders.read",
    "home.coffee.turn_on",
    "home.coffee.turn_off",
    "system.rog_g703.wake",
    "system.rog_g703.sleep",
    "system.rog_g703.hibernate",
    "navigation.overview",
    "navigation.calendar",
    "navigation.tasks",
    "navigation.reminders",
    "navigation.settings",
    "general.question",
    "jarvis.cancel",
    "jarvis.stop",
]
IntentKind = Literal["read", "action", "navigation", "conversational", "fallback"]
ConfidenceClass = Literal["exact", "strong", "ambiguous", "fallback"]
TimeScope = Literal["today", "tomorrow", "upcoming", "unspecified"]


@dataclass(frozen=True)
class IntentDefinition:
    """One source-controlled registry entry.

    The registry is intentionally data, not an executable action map.  An
    action ID here is only a classification label for a future policy-aware
    layer.
    """

    id: IntentId
    kind: IntentKind
    requires_confirmation: bool


INTENT_REGISTRY: Final[tuple[IntentDefinition, ...]] = (
    IntentDefinition("weather.read", "read", False),
    IntentDefinition("planning.calendar.read", "read", False),
    IntentDefinition("planning.tasks.read", "read", False),
    IntentDefinition("planning.reminders.read", "read", False),
    IntentDefinition("home.coffee.turn_on", "action", True),
    IntentDefinition("home.coffee.turn_off", "action", True),
    IntentDefinition("system.rog_g703.wake", "action", True),
    IntentDefinition("system.rog_g703.sleep", "action", True),
    IntentDefinition("system.rog_g703.hibernate", "action", True),
    IntentDefinition("navigation.overview", "navigation", False),
    IntentDefinition("navigation.calendar", "navigation", False),
    IntentDefinition("navigation.tasks", "navigation", False),
    IntentDefinition("navigation.reminders", "navigation", False),
    IntentDefinition("navigation.settings", "navigation", False),
    IntentDefinition("general.question", "fallback", False),
    IntentDefinition("jarvis.cancel", "conversational", False),
    IntentDefinition("jarvis.stop", "conversational", False),
)
_REGISTRY_BY_ID: Final[dict[str, IntentDefinition]] = {
    definition.id: definition for definition in INTENT_REGISTRY
}


class JarvisIntentSlots(BaseModel):
    """The complete, intentionally small slot vocabulary for this slice."""

    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)

    location: str | None = Field(default=None, max_length=MAX_LOCATION_CODEPOINTS)
    time_scope: TimeScope = Field(default="unspecified", alias="timeScope")


class JarvisIntentEnvelope(BaseModel):
    """A bounded interpretation; it is not an executable command."""

    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)

    schema_version: Literal["jarvis.intent.v1"] = Field(
        default=JARVIS_INTENT_SCHEMA_VERSION,
        alias="schemaVersion",
    )
    intent_id: IntentId = Field(alias="intentId")
    kind: IntentKind
    confidence_class: ConfidenceClass = Field(alias="confidenceClass")
    normalized_text: str = Field(
        max_length=MAX_TRANSCRIPT_CODEPOINTS,
        alias="normalizedText",
    )
    slots: JarvisIntentSlots
    requires_confirmation: bool = Field(alias="requiresConfirmation")


class JarvisInvalidInput(BaseModel):
    """Typed fail-closed result for input that cannot be classified."""

    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)

    schema_version: Literal["jarvis.intent.v1"] = Field(
        default=JARVIS_INTENT_SCHEMA_VERSION,
        alias="schemaVersion",
    )
    status: Literal["invalid"] = "invalid"
    code: Literal["transcript_not_text", "transcript_too_long"]


JarvisClassification = Union[JarvisIntentEnvelope, JarvisInvalidInput]


@dataclass(frozen=True)
class _PreparedTranscript:
    normalized: str
    matching: str
    tokens: tuple[str, ...]
    had_question_punctuation: bool
    original_casefolded: str


@dataclass(frozen=True)
class _MatchedIntent:
    intent_id: IntentId
    confidence_class: ConfidenceClass
    slots: JarvisIntentSlots


_SAFE_LOCATION = re.compile(r"^[a-zа-яё]+(?:[ -][a-zа-яё]+)*$", re.IGNORECASE)
_QUESTION_WORDS = frozenset(
    {
        "как",
        "почему",
        "зачем",
        "можно",
        "можешь",
        "можете",
        "нужно",
        "стоит",
        "когда",
        "что",
        "подскажи",
        "расскажи",
        "объясни",
        "если",
        "ли",
    }
)
_NEGATION_WORDS = frozenset({"не", "нельзя", "никогда", "ни"})
_COFFEE_ON_VERBS = frozenset(
    {"включи", "включите", "вруби", "врубите", "запусти", "запустите"}
)
_COFFEE_OFF_VERBS = frozenset(
    {"выключи", "выключите", "отключи", "отключите", "выруби", "вырубите"}
)
_ROG_WAKE_VERBS = frozenset(
    {"разбуди", "разбудите", "включи", "включите", "вруби", "врубите", "запусти", "запустите"}
)
_ROG_SLEEP_VERBS = frozenset(
    {"усыпи", "усыпите", "отправь", "отправьте", "переведи", "переведите"}
)
_ROG_TARGETS = frozenset({"асус", "asus", "rog"})
_NAVIGATION_VERBS = frozenset(
    {"открой", "откройте", "перейди", "перейдите", "переключись", "переключитесь", "зайди", "зайдите"}
)
_CANCEL_STEMS = ("отмен", "отбой")
_STOP_STEMS = ("стоп", "останов", "прекрат", "хват")
_CANONICAL_EXACT_PHRASES = frozenset(
    {
        "погода",
        "какая погода",
        "что с погодой",
        "какая сегодня погода",
        "погода в москве",
        "что с погодой в санкт петербурге",
        "что у меня сегодня",
        "какие сегодня события",
        "покажи календарь",
        "что в календаре",
        "какие встречи завтра",
        "какие у меня задачи",
        "покажи задачи",
        "что по задачам",
        "дела на сегодня",
        "какие у меня напоминания",
        "покажи напоминания",
        "что мне нужно не забыть",
        "включи кофемашину",
        "включи кофе машину",
        "выключи кофемашину",
        "отключи кофемашину",
        "разбуди асус",
        "включи асус",
        "разбуди rog",
        "отправь асус в сон",
        "усыпи асус",
        "гибернация асус",
        "отправь асус в гибернацию",
        "открой календарь",
        "открой задачи",
        "открой напоминания",
        "открой настройки",
        "открой главную",
        "покажи обзор",
        "отмена",
        "отмени",
        "стоп",
        "остановись",
        "прекрати",
    }
)


def _normalized_text(transcript: str) -> str:
    nfc = unicodedata.normalize("NFC", transcript)
    safe_chars: list[str] = []
    for character in nfc:
        category = unicodedata.category(character)
        if character.isspace() or category.startswith("C") or category.startswith("P"):
            safe_chars.append(" ")
        else:
            safe_chars.append(character)
    return " ".join("".join(safe_chars).casefold().split())


def _prepare(transcript: str) -> _PreparedTranscript | JarvisInvalidInput:
    if not isinstance(transcript, str):
        return JarvisInvalidInput(code="transcript_not_text")
    if len(transcript) > MAX_TRANSCRIPT_CODEPOINTS:
        return JarvisInvalidInput(code="transcript_too_long")
    original_casefolded = unicodedata.normalize("NFC", transcript).casefold()
    normalized = _normalized_text(transcript)
    if len(normalized) > MAX_TRANSCRIPT_CODEPOINTS:
        return JarvisInvalidInput(code="transcript_too_long")
    return _PreparedTranscript(
        normalized=normalized,
        matching=normalized.replace("ё", "е"),
        tokens=tuple(normalized.replace("ё", "е").split()),
        had_question_punctuation="?" in original_casefolded or "؟" in original_casefolded,
        original_casefolded=original_casefolded,
    )


def _has_stem(tokens: Sequence[str], *stems: str) -> bool:
    return any(token.startswith(stem) for token in tokens for stem in stems)


def _has_phrase(tokens: Sequence[str], words: Sequence[str]) -> bool:
    width = len(words)
    return any(tuple(tokens[index : index + width]) == tuple(words) for index in range(len(tokens) - width + 1))


def _has_any_phrase(tokens: Sequence[str], phrases: Sequence[Sequence[str]]) -> bool:
    return any(_has_phrase(tokens, phrase) for phrase in phrases)


def _is_question_or_explanatory(prepared: _PreparedTranscript) -> bool:
    return prepared.had_question_punctuation or bool(_QUESTION_WORDS.intersection(prepared.tokens))


def _has_explicit_negation(prepared: _PreparedTranscript) -> bool:
    return bool(_NEGATION_WORDS.intersection(prepared.tokens)) or _has_phrase(
        prepared.tokens,
        ("не", "надо"),
    )


def _has_coffee_object(tokens: Sequence[str]) -> bool:
    return _has_stem(tokens, "кофемашин") or _has_phrase(
        tokens,
        ("кофе", "машин"),
    ) or _has_phrase(tokens, ("кофе", "машину"))


def _intent(
    intent_id: IntentId,
    confidence_class: ConfidenceClass,
    normalized: str,
    slots: JarvisIntentSlots | None = None,
) -> JarvisIntentEnvelope:
    definition = _REGISTRY_BY_ID[intent_id]
    return JarvisIntentEnvelope(
        intentId=definition.id,
        kind=definition.kind,
        confidenceClass=confidence_class,
        normalizedText=normalized,
        slots=slots or JarvisIntentSlots(),
        requiresConfirmation=definition.requires_confirmation,
    )


def _invalid_location(prepared: _PreparedTranscript) -> bool:
    raw_location = re.search(r"\bв\s+(.+)$", prepared.original_casefolded, re.IGNORECASE)
    if not raw_location:
        return False
    candidate = raw_location.group(1).strip().rstrip("!?.,;:…")
    if any(character in candidate for character in "/\\:@."):
        return True
    return bool(re.search(r"\b(?:https?|www)\b", candidate, re.IGNORECASE))


def _weather_location(prepared: _PreparedTranscript) -> str | None | Literal[False]:
    if _invalid_location(prepared):
        return False
    location_match = re.search(r"\bв\s+(.+)$", prepared.matching)
    if not location_match:
        return None
    location = location_match.group(1).strip()
    if not location:
        return None
    if len(location) > MAX_LOCATION_CODEPOINTS or not _SAFE_LOCATION.fullmatch(location):
        return False
    known_locations = {
        "москва": "Москва",
        "москве": "Москва",
        "москвы": "Москва",
        "санкт петербург": "Санкт-Петербург",
        "санкт петербурге": "Санкт-Петербург",
        "петербург": "Санкт-Петербург",
        "петербурге": "Санкт-Петербург",
        "питере": "Санкт-Петербург",
        "спб": "Санкт-Петербург",
    }
    return known_locations.get(location, location)


def _classify_conversational(prepared: _PreparedTranscript) -> _MatchedIntent | None:
    if _is_question_or_explanatory(prepared):
        return None
    if any(_has_stem(prepared.tokens, stem) for stem in _CANCEL_STEMS):
        return _MatchedIntent("jarvis.cancel", "exact" if prepared.normalized in _CANONICAL_EXACT_PHRASES else "strong", JarvisIntentSlots())
    if any(_has_stem(prepared.tokens, stem) for stem in _STOP_STEMS):
        return _MatchedIntent("jarvis.stop", "exact" if prepared.normalized in _CANONICAL_EXACT_PHRASES else "strong", JarvisIntentSlots())
    return None


def _action_is_safe(prepared: _PreparedTranscript) -> bool:
    return not (
        _is_question_or_explanatory(prepared)
        or _has_explicit_negation(prepared)
        or "и" in prepared.tokens
        or "/" in prepared.original_casefolded
        or "\\" in prepared.original_casefolded
        or bool(re.search(r"\b(?:https?|www)\b", prepared.original_casefolded, re.IGNORECASE))
    )


def _classify_action(prepared: _PreparedTranscript) -> _MatchedIntent | None:
    if not _action_is_safe(prepared):
        return None

    has_coffee = _has_coffee_object(prepared.tokens)
    has_rog = bool(_ROG_TARGETS.intersection(prepared.tokens))
    if has_coffee and has_rog:
        return None

    if has_coffee:
        has_on = bool(_COFFEE_ON_VERBS.intersection(prepared.tokens))
        has_off = bool(_COFFEE_OFF_VERBS.intersection(prepared.tokens))
        if has_on == has_off:
            return None
        action_id: IntentId = "home.coffee.turn_on" if has_on else "home.coffee.turn_off"
        confidence: ConfidenceClass = "exact" if prepared.normalized in _CANONICAL_EXACT_PHRASES else "strong"
        return _MatchedIntent(action_id, confidence, JarvisIntentSlots())

    if not has_rog:
        return None

    has_wake = bool(_ROG_WAKE_VERBS.intersection(prepared.tokens))
    has_sleep_verb = bool(_ROG_SLEEP_VERBS.intersection(prepared.tokens))
    has_sleep_destination = _has_stem(prepared.tokens, "сон")
    has_hibernate = _has_stem(prepared.tokens, "гибернац")
    direct_hibernate = any(
        _has_phrase(prepared.tokens, (word, target))
        for word in ("гибернация", "гибернацию")
        for target in _ROG_TARGETS
    )

    candidates: list[IntentId] = []
    if has_wake:
        candidates.append("system.rog_g703.wake")
    if has_sleep_verb and (has_sleep_destination or _has_stem(prepared.tokens, "усып")):
        candidates.append("system.rog_g703.sleep")
    if has_sleep_verb and has_hibernate:
        candidates.append("system.rog_g703.hibernate")
    if direct_hibernate:
        candidates.append("system.rog_g703.hibernate")
    if len(set(candidates)) != 1:
        return None
    action_id = candidates[0]
    confidence = "exact" if prepared.normalized in _CANONICAL_EXACT_PHRASES else "strong"
    return _MatchedIntent(action_id, confidence, JarvisIntentSlots())


def _classify_navigation(prepared: _PreparedTranscript) -> _MatchedIntent | None:
    tokens = prepared.tokens
    overview_request = "покажи" in tokens and _has_stem(tokens, "главн", "обзор")
    if not (
        bool(_NAVIGATION_VERBS.intersection(tokens))
        or overview_request
    ):
        return None

    targets: list[IntentId] = []
    if _has_stem(tokens, "календар"):
        targets.append("navigation.calendar")
    if _has_stem(tokens, "задач"):
        targets.append("navigation.tasks")
    if _has_stem(tokens, "напоминан"):
        targets.append("navigation.reminders")
    if _has_stem(tokens, "настрой"):
        targets.append("navigation.settings")
    if _has_stem(tokens, "главн", "обзор"):
        targets.append("navigation.overview")
    if len(set(targets)) != 1:
        return None
    confidence = "exact" if prepared.normalized in _CANONICAL_EXACT_PHRASES else "strong"
    return _MatchedIntent(targets[0], confidence, JarvisIntentSlots())


def _time_scope(tokens: Sequence[str]) -> TimeScope | None:
    scopes: set[TimeScope] = set()
    if _has_stem(tokens, "сегодняш") or "сегодня" in tokens:
        scopes.add("today")
    if _has_stem(tokens, "завтраш") or "завтра" in tokens:
        scopes.add("tomorrow")
    if _has_stem(tokens, "вперед", "ближай", "предстоящ", "предстоит"):
        scopes.add("upcoming")
    if len(scopes) > 1:
        return None
    return next(iter(scopes), "unspecified")


def _classify_read(prepared: _PreparedTranscript) -> _MatchedIntent | None:
    tokens = prepared.tokens
    weather = _has_stem(tokens, "погод")
    calendar = _has_stem(tokens, "календар", "событ", "встреч") or _has_phrase(
        tokens,
        ("что", "у", "меня"),
    )
    tasks = _has_stem(tokens, "задач", "дел")
    reminders = _has_stem(tokens, "напоминан") or _has_phrase(
        tokens,
        ("не", "забыть"),
    )
    domains = sum((weather, calendar, tasks, reminders))
    if domains != 1:
        return None

    time_scope = _time_scope(tokens)
    if time_scope is None:
        return None
    slots = JarvisIntentSlots(timeScope=time_scope)
    if weather:
        location = _weather_location(prepared)
        if location is False:
            return None
        return _MatchedIntent(
            "weather.read",
            "exact" if prepared.normalized in _CANONICAL_EXACT_PHRASES else "strong",
            JarvisIntentSlots(location=location, timeScope="unspecified"),
        )
    if calendar:
        return _MatchedIntent(
            "planning.calendar.read",
            "exact" if prepared.normalized in _CANONICAL_EXACT_PHRASES else "strong",
            slots,
        )
    if tasks:
        return _MatchedIntent(
            "planning.tasks.read",
            "exact" if prepared.normalized in _CANONICAL_EXACT_PHRASES else "strong",
            slots,
        )
    return _MatchedIntent(
        "planning.reminders.read",
        "exact" if prepared.normalized in _CANONICAL_EXACT_PHRASES else "strong",
        slots,
    )


class JarvisIntentRouter:
    """Pure deterministic router for recognized transcript text."""

    def classify(self, transcript: str) -> JarvisClassification:
        prepared = _prepare(transcript)
        if isinstance(prepared, JarvisInvalidInput):
            return prepared

        matched = _classify_conversational(prepared)
        if matched is None:
            matched = _classify_action(prepared)
        if matched is None:
            matched = _classify_navigation(prepared)
        if matched is None:
            matched = _classify_read(prepared)
        if matched is None:
            return _intent("general.question", "fallback", prepared.normalized)
        return _intent(
            matched.intent_id,
            matched.confidence_class,
            prepared.normalized,
            matched.slots,
        )


def classify_jarvis_intent(transcript: str) -> JarvisClassification:
    """Convenience entry point for future local voice/STT runtimes."""

    return JarvisIntentRouter().classify(transcript)
