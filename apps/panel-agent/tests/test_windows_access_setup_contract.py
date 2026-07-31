from pathlib import Path


def test_access_pin_setup_enables_coffee_only_for_ready_production_transport() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    script = (
        repository_root / "scripts" / "windows" / "set-access-pin.ps1"
    ).read_text(encoding="utf-8")

    for entry in (
        '"PANEL_HA_URL"',
        '"PANEL_HA_TOKEN"',
        '"PANEL_ALICE_BASE_URL"',
        '"PANEL_ALICE_CONTROL_CENTER_TOKEN"',
        '$mode -eq "production"',
        'Set-RuntimeEnvEntry -Key "PANEL_FIXTURE_WRITES_ENABLED" -Value "false"',
        'Set-RuntimeEnvEntry -Key "PANEL_COFFEE_ACTIONS_ENABLED" -Value $coffeeGateValue',
        'Set-RuntimeEnvEntry -Key "PANEL_COFFEE_TIMING_WRITES_ENABLED" -Value $coffeeGateValue',
        'Set-RuntimeEnvEntry -Key "PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED" -Value $coffeeGateValue',
        'Set-RuntimeEnvEntry -Key "PANEL_WRITES_ENABLED" -Value "true"',
    ):
        assert entry in script

    assert "$script:RuntimeEnvLines" in script
    assert "Stop-ArtemRuntime" in script
    assert "Wait-ArtemPanelReady" in script
    assert "PANEL_AVALAR_MAIN_DEPLOY_ENABLED" not in script
