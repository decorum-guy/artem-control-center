from __future__ import annotations

from panel_agent.jarvis_core import classify_jarvis_text, normalize_jarvis_text


def test_russian_normalization_is_bounded_and_matches_yo_case_punctuation_and_space():
    assert normalize_jarvis_text("  ДЖАРВИС,   КОТОРЫЙ\tСЕЙЧАС ЧАС?! ") == "джарвис который сейчас час"
    assert classify_jarvis_text("Джарвис, который сейчас час?").intent_id == "system.time.current"
    assert classify_jarvis_text("ПОВТОРИ!").intent_id == "jarvis.repeat"
    assert classify_jarvis_text("Ещё раз").intent_id == "jarvis.repeat"


def test_closed_registry_never_accepts_client_intent_or_command_shaped_text():
    assert classify_jarvis_text("intentId=navigation.system; /bin/sh -c whoami").intent_id == "general.question"
    assert classify_jarvis_text("light.kitchen turn_on").intent_id == "general.question"
    assert classify_jarvis_text("не включи кофемашину").intent_id == "general.question"
    classified = classify_jarvis_text("включи кофемашину")
    assert classified.intent_id == "home.coffee.turn_on"
    assert classified.kind == "future_mutation"
