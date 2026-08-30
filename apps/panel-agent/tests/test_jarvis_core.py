from __future__ import annotations

import json

import pytest

from panel_agent.jarvis_core import (
    INTENT_REGISTRY,
    MAX_LOCATION_CODEPOINTS,
    MAX_TRANSCRIPT_CODEPOINTS,
    JarvisIntentEnvelope,
    JarvisInvalidInput,
    JarvisIntentRouter,
)


router = JarvisIntentRouter()


@pytest.mark.parametrize(
    ("transcript", "intent_id", "scope"),
    [
        ("какая погода", "weather.read", "unspecified"),
        ("погода", "weather.read", "unspecified"),
        ("что с погодой", "weather.read", "unspecified"),
        ("какая сегодня погода", "weather.read", "unspecified"),
        ("погода в Москве", "weather.read", "unspecified"),
        ("что с погодой в Санкт-Петербурге", "weather.read", "unspecified"),
        ("что у меня сегодня", "planning.calendar.read", "today"),
        ("какие сегодня события", "planning.calendar.read", "today"),
        ("покажи календарь", "planning.calendar.read", "unspecified"),
        ("что в календаре", "planning.calendar.read", "unspecified"),
        ("какие встречи завтра", "planning.calendar.read", "tomorrow"),
        ("какие у меня задачи", "planning.tasks.read", "unspecified"),
        ("покажи задачи", "planning.tasks.read", "unspecified"),
        ("что по задачам", "planning.tasks.read", "unspecified"),
        ("дела на сегодня", "planning.tasks.read", "today"),
        ("какие у меня напоминания", "planning.reminders.read", "unspecified"),
        ("покажи напоминания", "planning.reminders.read", "unspecified"),
        ("что мне нужно не забыть", "planning.reminders.read", "unspecified"),
        ("включи кофемашину", "home.coffee.turn_on", "unspecified"),
        ("включи кофе машину", "home.coffee.turn_on", "unspecified"),
        ("выключи кофемашину", "home.coffee.turn_off", "unspecified"),
        ("отключи кофемашину", "home.coffee.turn_off", "unspecified"),
        ("разбуди асус", "system.rog_g703.wake", "unspecified"),
        ("включи асус", "system.rog_g703.wake", "unspecified"),
        ("разбуди rog", "system.rog_g703.wake", "unspecified"),
        ("отправь асус в сон", "system.rog_g703.sleep", "unspecified"),
        ("усыпи асус", "system.rog_g703.sleep", "unspecified"),
        ("гибернация асус", "system.rog_g703.hibernate", "unspecified"),
        ("гибернация rog", "system.rog_g703.hibernate", "unspecified"),
        ("отправь асус в гибернацию", "system.rog_g703.hibernate", "unspecified"),
        ("открой календарь", "navigation.calendar", "unspecified"),
        ("открой задачи", "navigation.tasks", "unspecified"),
        ("открой напоминания", "navigation.reminders", "unspecified"),
        ("открой настройки", "navigation.settings", "unspecified"),
        ("открой главную", "navigation.overview", "unspecified"),
        ("покажи обзор", "navigation.overview", "unspecified"),
        ("покажи мне обзор", "navigation.overview", "unspecified"),
        ("отмена", "jarvis.cancel", "unspecified"),
        ("отмени", "jarvis.cancel", "unspecified"),
        ("стоп", "jarvis.stop", "unspecified"),
        ("остановись", "jarvis.stop", "unspecified"),
        ("прекрати", "jarvis.stop", "unspecified"),
    ],
)
def test_required_phrases_route_to_fixed_typed_intents(transcript, intent_id, scope):
    result = router.classify(transcript)

    assert isinstance(result, JarvisIntentEnvelope)
    assert result.intent_id == intent_id
    assert result.slots.time_scope == scope
    assert result.requires_confirmation is (intent_id.startswith("home.") or intent_id.startswith("system."))


@pytest.mark.parametrize(
    ("transcript", "location"),
    [
        ("погода", None),
        ("погода в Москве", "Москва"),
        ("что с погодой в Санкт-Петербурге", "Санкт-Петербург"),
    ],
)
def test_weather_location_is_optional_and_bounded(transcript, location):
    result = router.classify(transcript)

    assert isinstance(result, JarvisIntentEnvelope)
    assert result.intent_id == "weather.read"
    assert result.slots.location == location
    assert result.slots.location is None or len(result.slots.location) <= MAX_LOCATION_CODEPOINTS


def test_weather_rejects_unsafe_or_oversized_location_instead_of_accepting_it():
    oversized = "а" * (MAX_LOCATION_CODEPOINTS + 1)
    unsafe = router.classify("погода в https://example.test/private")
    too_long = router.classify(f"погода в {oversized}")

    assert isinstance(unsafe, JarvisIntentEnvelope)
    assert unsafe.intent_id == "general.question"
    assert isinstance(too_long, JarvisIntentEnvelope)
    assert too_long.intent_id == "general.question"
    assert too_long.slots.location is None


@pytest.mark.parametrize(
    "transcript",
    [
        "кофемашина",
        "асус",
        "почему асус не просыпается?",
        "как включить кофемашину?",
        "включи кофемашину и чайник",
        "включи и выключи кофемашину",
        "гибернация асус?",
        "включи кофемашину https://example.test",
        "разбуди асус /tmp/device",
    ],
)
def test_action_false_positive_adversaries_fail_closed(transcript):
    result = router.classify(transcript)

    assert isinstance(result, JarvisIntentEnvelope)
    assert result.intent_id == "general.question"
    assert result.requires_confirmation is False


@pytest.mark.parametrize(
    "transcript",
    [
        "не включай кофемашину",
        "не буди асус",
        "не отправляй асус в сон",
        "не включи кофемашину",
    ],
)
def test_explicit_negation_never_becomes_positive_action(transcript):
    result = router.classify(transcript)

    assert isinstance(result, JarvisIntentEnvelope)
    assert result.intent_id == "general.question"
    assert result.kind == "fallback"


def test_time_scope_supports_only_the_small_typed_vocabulary():
    assert router.classify("встречи сегодня").slots.time_scope == "today"
    assert router.classify("задачи завтра").slots.time_scope == "tomorrow"
    assert router.classify("что впереди в календаре").slots.time_scope == "upcoming"
    assert router.classify("что в календаре когда-нибудь потом").slots.time_scope == "unspecified"


def test_normalization_handles_unicode_case_whitespace_and_harmless_punctuation():
    result = router.classify("  КАКАЯ\nПОГОДА?!  ")

    assert isinstance(result, JarvisIntentEnvelope)
    assert result.intent_id == "weather.read"
    assert result.normalized_text == "какая погода"
    assert "\n" not in result.normalized_text


def test_oversized_transcript_returns_typed_invalid_result_without_processing():
    result = router.classify("а" * (MAX_TRANSCRIPT_CODEPOINTS + 1))

    assert isinstance(result, JarvisInvalidInput)
    assert result.code == "transcript_too_long"
    assert result.model_dump(by_alias=True) == {
        "schemaVersion": "jarvis.intent.v1",
        "status": "invalid",
        "code": "transcript_too_long",
    }


def test_unknown_text_is_bounded_general_question_fallback():
    result = router.classify("расскажи, пожалуйста, о чём-нибудь неизвестном")

    assert isinstance(result, JarvisIntentEnvelope)
    assert result.intent_id == "general.question"
    assert result.confidence_class == "fallback"
    assert result.kind == "fallback"
    assert len(result.normalized_text) <= MAX_TRANSCRIPT_CODEPOINTS


def test_registry_is_fixed_and_envelopes_have_no_execution_fields():
    registry_ids = {definition.id for definition in INTENT_REGISTRY}
    required_ids = {
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
    }
    assert registry_ids == required_ids
    assert set(JarvisIntentEnvelope.model_fields) == {
        "schema_version",
        "intent_id",
        "kind",
        "confidence_class",
        "normalized_text",
        "slots",
        "requires_confirmation",
    }
    assert "command" not in JarvisIntentEnvelope.model_fields
    assert "path" not in JarvisIntentEnvelope.model_fields
    assert "url" not in JarvisIntentEnvelope.model_fields
    assert "endpoint" not in JarvisIntentEnvelope.model_fields
    assert "callable" not in JarvisIntentEnvelope.model_fields


def test_same_normalized_input_is_deterministic_and_json_bounded():
    first = router.classify("  ПОГОДА В МОСКВЕ!!! ")
    second = router.classify("  ПОГОДА В МОСКВЕ!!! ")

    assert first.model_dump(by_alias=True) == second.model_dump(by_alias=True)
    assert len(json.dumps(first.model_dump(by_alias=True), ensure_ascii=False).encode("utf-8")) < 4096


def test_non_text_input_fails_closed():
    result = router.classify(None)  # type: ignore[arg-type]

    assert isinstance(result, JarvisInvalidInput)
    assert result.code == "transcript_not_text"
