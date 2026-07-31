from pathlib import Path


def test_access_pin_setup_enables_standard_action_gates() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    script = (
        repository_root / "scripts" / "windows" / "set-access-pin.ps1"
    ).read_text(encoding="utf-8")

    for entry in (
        'PANEL_WRITES_ENABLED = "true"',
        'PANEL_COFFEE_ACTIONS_ENABLED = "true"',
        'PANEL_COFFEE_TIMING_WRITES_ENABLED = "true"',
        'PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED = "true"',
    ):
        assert entry in script

    assert "$script:RuntimeEnvLines" in script
    assert "Stop-ArtemRuntime" in script
    assert "Wait-ArtemPanelReady" in script
    assert "PANEL_AVALAR_MAIN_DEPLOY_ENABLED" not in script
