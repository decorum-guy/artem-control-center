import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from panel_agent.coffee_delayed_start import (
    MAX_DELAY_MINUTES,
    MAX_FILE_BYTES,
    MIN_DELAY_MINUTES,
    CoffeeDelayedStartError,
    CoffeeDelayedStartScheduler,
    CoffeeDelayedStartStore,
    validate_delay_minutes,
)


class FakeClock:
    def __init__(self):
        self.value = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.value

    def advance(self, **kwargs):
        self.value += timedelta(**kwargs)


def make_scheduler(tmp_path, clock, state=None, authority=None, calls=None):
    state = state if state is not None else {"machine": "off", "authority": True}
    calls = calls if calls is not None else []

    async def execute(request_id):
        calls.append(request_id)

    scheduler = CoffeeDelayedStartScheduler(
        tmp_path / "coffee-delayed-start.json",
        can_schedule=lambda: state["authority"] if authority is None else authority[0],
        execute_turn_on=execute,
        machine_state=lambda: state["machine"],
        clock=clock,
    )
    return scheduler, state, calls


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("delay_minutes", [5, 10, 15, 37])
def test_presets_and_custom_delay_values_create_a_confirmed_schedule(tmp_path, delay_minutes):
    clock = FakeClock()
    scheduler, _, _ = make_scheduler(tmp_path, clock)

    created = run(scheduler.create_or_replace(delay_minutes, f"request-{delay_minutes:03d}"))

    assert created["delayMinutes"] == delay_minutes
    assert created["status"] == "pending"


def test_presets_and_custom_delay_values_are_accepted():
    assert [validate_delay_minutes(value) for value in (5, 10, 15, 37)] == [5, 10, 15, 37]
    assert MIN_DELAY_MINUTES == 1
    assert MAX_DELAY_MINUTES == 120


@pytest.mark.parametrize("value", [0, -1, MAX_DELAY_MINUTES + 1, 1.5, "5", True, None, float("nan")])
def test_delay_bounds_reject_zero_negative_huge_and_malformed_values(value):
    with pytest.raises(CoffeeDelayedStartError, match="delay_invalid"):
        validate_delay_minutes(value)


def test_durable_readback_survives_new_scheduler_instance(tmp_path):
    clock = FakeClock()
    first, _, _ = make_scheduler(tmp_path, clock)
    created = run(first.create_or_replace(5, "request-0005"))

    second, _, _ = make_scheduler(tmp_path, clock)
    assert second.read() == created
    assert json.loads((tmp_path / "coffee-delayed-start.json").read_text())["schemaVersion"] == "coffee.delayed-start.v1"


def test_replacement_keeps_exactly_one_active_record(tmp_path):
    clock = FakeClock()
    scheduler, _, _ = make_scheduler(tmp_path, clock)
    first = run(scheduler.create_or_replace(5, "request-first"))
    second = run(scheduler.create_or_replace(10, "request-second"))

    assert second["scheduleId"] != first["scheduleId"]
    assert second["status"] == "pending"
    assert scheduler.read()["scheduleId"] == second["scheduleId"]
    document = json.loads((tmp_path / "coffee-delayed-start.json").read_text())
    assert isinstance(document, dict)
    assert document["scheduleId"] == second["scheduleId"]
    assert len((tmp_path / "coffee-delayed-start.json").read_bytes()) < MAX_FILE_BYTES


def test_duplicate_create_request_is_idempotent(tmp_path):
    clock = FakeClock()
    scheduler, _, _ = make_scheduler(tmp_path, clock)
    first = run(scheduler.create_or_replace(5, "request-duplicate"))
    second = run(scheduler.create_or_replace(15, "request-duplicate"))
    assert second == first


def test_cancellation_is_deterministic_and_idempotent(tmp_path):
    clock = FakeClock()
    scheduler, _, _ = make_scheduler(tmp_path, clock)
    run(scheduler.create_or_replace(5, "request-cancel"))

    cancelled = run(scheduler.cancel())
    repeated = run(scheduler.cancel())
    assert cancelled["status"] == "cancelled"
    assert cancelled["failureCode"] == "cancelled_by_owner"
    assert repeated == cancelled


def test_cancellation_works_after_scheduler_recovery(tmp_path):
    clock = FakeClock()
    first, _, _ = make_scheduler(tmp_path, clock)
    run(first.create_or_replace(5, "request-cancel-recovered"))

    recovered, _, _ = make_scheduler(tmp_path, clock)
    cancelled = run(recovered.cancel())

    assert cancelled["status"] == "cancelled"
    assert recovered.read() == cancelled


def test_concurrent_due_claims_have_one_winner(tmp_path):
    clock = FakeClock()
    scheduler, _, calls = make_scheduler(tmp_path, clock)

    async def exercise():
        await scheduler.create_or_replace(5, "request-race")
        clock.advance(minutes=5)
        claims = await asyncio.gather(scheduler._claim_due(), scheduler._claim_due())
        winner = next(claim for claim in claims if claim is not None)
        assert sum(claim is not None for claim in claims) == 1
        await scheduler._execute_turn_on(winner[1])
        await scheduler._finish(winner[0], "succeeded", None)

    run(exercise())
    assert calls == ["request-race"]
    assert scheduler.read()["status"] == "succeeded"


def test_replacement_does_not_overwrite_a_durable_execution_claim(tmp_path):
    clock = FakeClock()
    scheduler, _, _ = make_scheduler(tmp_path, clock)
    run(scheduler.create_or_replace(5, "request-executing"))
    clock.advance(minutes=5)
    assert run(scheduler._claim_due()) is not None

    with pytest.raises(CoffeeDelayedStartError, match="execution_in_progress"):
        run(scheduler.create_or_replace(10, "request-replacement"))


def test_restart_before_due_resumes_durable_pending_schedule(tmp_path):
    clock = FakeClock()
    first, _, _ = make_scheduler(tmp_path, clock)
    created = run(first.create_or_replace(5, "request-restart"))
    second, _, calls = make_scheduler(tmp_path, clock)

    async def exercise():
        await second.start()
        await asyncio.sleep(0)
        assert second.read() == created
        clock.advance(minutes=5)
        second._current_wake().set()
        for _ in range(4):
            await asyncio.sleep(0)
        await second.close()

    run(exercise())
    assert calls == ["request-restart"]
    assert second.read()["status"] == "succeeded"


def test_restart_at_due_executes_at_most_once(tmp_path):
    clock = FakeClock()
    first, _, first_calls = make_scheduler(tmp_path, clock)
    run(first.create_or_replace(5, "request-due"))
    clock.advance(minutes=5)
    second, _, second_calls = make_scheduler(tmp_path, clock)

    async def exercise():
        await second.start()
        for _ in range(4):
            await asyncio.sleep(0)
        await second.close()

    run(exercise())
    assert first_calls == []
    assert second_calls == ["request-due"]
    assert second.read()["status"] == "succeeded"


def test_restart_with_durable_execution_claim_does_not_duplicate_turn_on(tmp_path):
    clock = FakeClock()
    scheduler, _, calls = make_scheduler(tmp_path, clock)
    run(scheduler.create_or_replace(5, "request-claimed"))
    clock.advance(minutes=5)
    claim = run(scheduler._claim_due())
    assert claim is not None

    recovered, _, recovered_calls = make_scheduler(tmp_path, clock)
    async def recover():
        await recovered.start()
        await recovered.close()

    run(recover())
    assert recovered_calls == []
    assert calls == []
    assert recovered.read()["status"] == "failed"
    assert recovered.read()["failureCode"] == "coffee_delayed_start_execution_uncertain"


def test_due_execution_failure_is_truthful_terminal_failure(tmp_path):
    clock = FakeClock()
    state = {"machine": "off", "authority": True}

    async def fail(_request_id):
        raise CoffeeDelayedStartError("coffee_action_unavailable")

    scheduler = CoffeeDelayedStartScheduler(
        tmp_path / "coffee-delayed-start.json",
        can_schedule=lambda: state["authority"],
        execute_turn_on=fail,
        machine_state=lambda: state["machine"],
        clock=clock,
    )

    async def exercise():
        await scheduler.create_or_replace(5, "request-failure")
        clock.advance(minutes=5)
        await scheduler.start()
        for _ in range(4):
            await asyncio.sleep(0)
        await scheduler.close()

    run(exercise())
    assert scheduler.read()["status"] == "failed"
    assert scheduler.read()["failureCode"] == "coffee_action_unavailable"


def test_due_time_unavailable_authority_does_not_fake_success(tmp_path):
    clock = FakeClock()
    authority = [True]
    scheduler, _, calls = make_scheduler(tmp_path, clock, authority=authority)

    async def exercise():
        await scheduler.create_or_replace(5, "request-unavailable")
        authority[0] = False
        clock.advance(minutes=5)
        await scheduler.start()
        for _ in range(3):
            await asyncio.sleep(0)
        await scheduler.close()

    run(exercise())
    assert calls == []
    assert scheduler.read()["status"] == "failed"
    assert scheduler.read()["failureCode"] == "coffee_delayed_start_unavailable_at_due_time"


def test_unknown_state_cannot_be_scheduled_or_executed(tmp_path):
    clock = FakeClock()
    scheduler, state, _ = make_scheduler(tmp_path, clock)

    async def exercise():
        state["machine"] = "unknown"
        with pytest.raises(CoffeeDelayedStartError, match="unavailable"):
            await scheduler.create_or_replace(5, "request-unknown")

    run(exercise())
    assert scheduler.read() is None


def test_manual_on_reconciliation_cancels_pending_schedule(tmp_path):
    clock = FakeClock()
    scheduler, state, _ = make_scheduler(tmp_path, clock)
    run(scheduler.create_or_replace(5, "request-manual-on"))
    state["machine"] = "on"

    reconciled = run(scheduler.reconcile())
    assert reconciled["status"] == "cancelled"
    assert reconciled["failureCode"] == "coffee_machine_turned_on_manually"


def test_store_ignores_oversized_or_invalid_history_documents(tmp_path):
    path = tmp_path / "coffee-delayed-start.json"
    path.write_text("x" * (MAX_FILE_BYTES + 1))
    assert CoffeeDelayedStartStore(path).read() is None
    path.write_text(json.dumps([{"status": "pending"}]))
    assert CoffeeDelayedStartStore(path).read() is None
