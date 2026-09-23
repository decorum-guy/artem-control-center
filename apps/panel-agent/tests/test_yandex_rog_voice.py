from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from panel_agent.rog_g703_power import (
    ROG_G703_HIBERNATE_ACTION,
    ROG_G703_SLEEP_ACTION,
    ROG_G703_WAKE_ACTION,
)
from panel_agent.settings import IntegrationSettings
from panel_agent.yandex_rog_voice import (
    MAX_YANDEX_ROG_COMMAND_CODEPOINTS,
    YandexRogVoiceBridge,
    parse_yandex_rog_voice_command,
)


class FakeExecutor:
    def __init__(
        self,
        *,
        allowed: bool = True,
        availability: str = "allowed",
        status: str = "offline",
    ) -> None:
        self.allowed = allowed
        self.availability_value = availability
        self.status = status
        self.requests: list[str] = []

    def availability(self, action_id: str) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "availability": self.availability_value,
            "status": self.status,
            "targetId": "rog_g703gi",
        }

    async def start(self, request) -> SimpleNamespace:
        self.requests.append(request.actionId)
        return SimpleNamespace(status="requested")


class FakeResponder:
    def __init__(self) -> None:
        self.responses: list[str] = []

    async def respond_to_yandex_intent(self, text: str) -> None:
        self.responses.append(text)


def bridge(*, enabled: bool = True, executor: FakeExecutor | None = None):
    responder = FakeResponder()
    executor = executor or FakeExecutor()
    subject = YandexRogVoiceBridge(
        IntegrationSettings(rog_g703_alice_enabled=enabled),
        executor,  # type: ignore[arg-type]
        responder,
    )
    return subject, executor, responder


@pytest.mark.parametrize(
    ("phrase", "action_id"),
    [
        ("включить асус", ROG_G703_WAKE_ACTION),
        ("включи асус", ROG_G703_WAKE_ACTION),
        ("перевести асус в сон", ROG_G703_SLEEP_ACTION),
        ("переведи асус в сон", ROG_G703_SLEEP_ACTION),
        ("отправить асус в сон", ROG_G703_SLEEP_ACTION),
        ("отправь асус в сон", ROG_G703_SLEEP_ACTION),
        ("перевести асус в гибернацию", ROG_G703_HIBERNATE_ACTION),
        ("переведи асус в гибернацию", ROG_G703_HIBERNATE_ACTION),
        ("отправить асус в гибернацию", ROG_G703_HIBERNATE_ACTION),
        ("отправь асус в гибернацию", ROG_G703_HIBERNATE_ACTION),
        ("разбудить асус", ROG_G703_WAKE_ACTION),
        ("разбуди асус", ROG_G703_WAKE_ACTION),
        ("включить ASUS", ROG_G703_WAKE_ACTION),
        ("включи ASUS", ROG_G703_WAKE_ACTION),
        ("разбудить ASUS", ROG_G703_WAKE_ACTION),
        ("разбуди ASUS", ROG_G703_WAKE_ACTION),
        ("перевести ASUS в сон", ROG_G703_SLEEP_ACTION),
        ("переведи ASUS в сон", ROG_G703_SLEEP_ACTION),
        ("отправить ASUS в сон", ROG_G703_SLEEP_ACTION),
        ("отправь ASUS в сон", ROG_G703_SLEEP_ACTION),
        ("перевести ASUS в гибернацию", ROG_G703_HIBERNATE_ACTION),
        ("переведи ASUS в гибернацию", ROG_G703_HIBERNATE_ACTION),
        ("отправить ASUS в гибернацию", ROG_G703_HIBERNATE_ACTION),
        ("отправь ASUS в гибернацию", ROG_G703_HIBERNATE_ACTION),
    ],
)
def test_parser_accepts_only_the_closed_asus_grammar(phrase: str, action_id: str) -> None:
    assert parse_yandex_rog_voice_command({"command": phrase}) == action_id


def test_parser_normalizes_case_and_whitespace() -> None:
    assert parse_yandex_rog_voice_command({"command": "  ВКЛЮЧИ   АСУС  "}) == ROG_G703_WAKE_ACTION
    assert parse_yandex_rog_voice_command({"command": "переведи асус в гибернацию"}) == ROG_G703_HIBERNATE_ACTION


@pytest.mark.parametrize(
    "event_data",
    [
        {"command": "попроси домашнего помощника включить асус"},
        {"command": "включить асус немедленно"},
        {"command": "выключить асус"},
        {"command": "включить асус; shutdown /s"},
        {"command": "system.rog_g703.hibernate"},
        {"command": "service: switch.turn_on entity_id: switch.asus"},
        {"command": "разбудить host 192.168.1.10"},
        {"command": 1},
        {},
    ],
)
def test_parser_rejects_unknown_or_dangerous_input(event_data: dict) -> None:
    assert parse_yandex_rog_voice_command(event_data) is None


def test_parser_uses_text_only_when_command_is_missing() -> None:
    assert parse_yandex_rog_voice_command({"text": "включи асус"}) == ROG_G703_WAKE_ACTION
    assert parse_yandex_rog_voice_command(
        {"command": "выключить асус", "text": "включи асус"}
    ) is None


def test_parser_rejects_oversized_command_without_text_fallback() -> None:
    within_limit = " " * (MAX_YANDEX_ROG_COMMAND_CODEPOINTS - len("включи асус")) + "включи асус"
    over_limit = within_limit + " "

    assert len(within_limit) == MAX_YANDEX_ROG_COMMAND_CODEPOINTS
    assert parse_yandex_rog_voice_command({"command": within_limit}) == ROG_G703_WAKE_ACTION
    assert parse_yandex_rog_voice_command(
        {"command": over_limit, "text": "включи асус"}
    ) is None


def test_oversized_fallback_text_does_not_execute_or_respond() -> None:
    subject, executor, responder = bridge()
    oversized_text = "включи асус" + " " * MAX_YANDEX_ROG_COMMAND_CODEPOINTS

    assert parse_yandex_rog_voice_command({"text": oversized_text}) is None
    asyncio.run(subject.handle({"text": oversized_text}))

    assert executor.requests == []
    assert responder.responses == []


@pytest.mark.parametrize(
    ("phrase", "action_id", "response"),
    [
        ("включи асус", ROG_G703_WAKE_ACTION, "Включаю ASUS."),
        ("отправь асус в сон", ROG_G703_SLEEP_ACTION, "Перевожу ASUS в сон."),
        (
            "отправь асус в гибернацию",
            ROG_G703_HIBERNATE_ACTION,
            "Перевожу ASUS в гибернацию.",
        ),
    ],
)
def test_bridge_routes_only_fixed_actions_and_answers_immediately(
    phrase: str,
    action_id: str,
    response: str,
) -> None:
    subject, executor, responder = bridge()
    asyncio.run(subject.handle({"command": phrase}))

    assert executor.requests == [action_id]
    assert responder.responses == [response]


def test_default_feature_gate_does_not_mutate_or_compete_for_response() -> None:
    assert IntegrationSettings().rog_g703_alice_enabled is False
    subject, executor, responder = bridge(enabled=False)
    asyncio.run(subject.handle({"command": "включить асус"}))

    assert executor.requests == []
    assert responder.responses == []


def test_unknown_yandex_command_does_not_mutate_or_respond() -> None:
    subject, executor, responder = bridge()
    asyncio.run(subject.handle({"command": "напомни мне через час"}))

    assert executor.requests == []
    assert responder.responses == []


@pytest.mark.parametrize(
    ("executor", "phrase", "expected"),
    [
        (FakeExecutor(allowed=False, availability="busy", status="waking"), "включи асус", "Команда для ASUS уже выполняется."),
        (FakeExecutor(allowed=False, availability="precondition_failed", status="online"), "включи асус", "ASUS уже в сети."),
        (FakeExecutor(allowed=False, availability="precondition_failed", status="offline"), "переведи асус в сон", "ASUS сейчас не в сети."),
        (FakeExecutor(allowed=False, availability="gate_disabled", status="offline"), "включи асус", "Управление ASUS сейчас недоступно."),
    ],
)
def test_bridge_returns_bounded_truthful_denials(
    executor: FakeExecutor,
    phrase: str,
    expected: str,
) -> None:
    subject, _, responder = bridge(executor=executor)
    asyncio.run(subject.handle({"command": phrase}))

    assert executor.requests == []
    assert responder.responses == [expected]
