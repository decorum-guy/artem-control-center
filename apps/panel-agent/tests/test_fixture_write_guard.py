from dataclasses import replace

from panel_agent import main


def test_fixture_writes_fail_closed_without_explicit_opt_in(monkeypatch):
    monkeypatch.setattr(main, "MODE", "fixtures")
    monkeypatch.setattr(
        main,
        "SETTINGS",
        replace(main.SETTINGS, writes_enabled=True),
    )
    monkeypatch.delenv("PANEL_FIXTURE_WRITES_ENABLED", raising=False)

    assert main._write_allowed(True) is False


def test_fixture_dev_launcher_can_opt_in_explicitly(monkeypatch):
    monkeypatch.setattr(main, "MODE", "fixtures")
    monkeypatch.setattr(
        main,
        "SETTINGS",
        replace(main.SETTINGS, writes_enabled=True),
    )
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "true")

    assert main._write_allowed(True) is True


def test_production_writes_do_not_depend_on_fixture_gate(monkeypatch):
    monkeypatch.setattr(main, "MODE", "production")
    monkeypatch.setattr(
        main,
        "SETTINGS",
        replace(main.SETTINGS, writes_enabled=True),
    )
    monkeypatch.setenv("PANEL_FIXTURE_WRITES_ENABLED", "false")

    assert main._write_allowed(True) is True
