import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from panel_agent.appearance import Appearance, AppearanceStore
from panel_agent.avalar_health import private_stage_status, probe_avalar_health


def test_palette_survives_reopen_and_concurrent_independent_changes(tmp_path):
    path = tmp_path / "appearance.json"
    store = AppearanceStore(path)
    assert store.read() == Appearance()
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(store.patch, [Appearance(accent="rose"), Appearance(colorMode="day")]))
    assert AppearanceStore(path).read() == Appearance(accent="rose", colorMode="day")
    with pytest.raises(ValidationError):
        Appearance(accent="unregistered")
    with pytest.raises(HTTPException):
        store.patch(Appearance(accent=None))
    path.write_text("bad json")
    with pytest.raises(HTTPException) as error:
        store.patch(Appearance(colorMode="night"))
    assert error.value.status_code == 503 and path.read_text() == "bad json"


@pytest.mark.parametrize("code,html,media,expected", [
    (200, '<title>AVALAR - Home</title><header id="mainHeader">', "text/html", "healthy"),
    (200, "<title>Hosting placeholder</title>", "text/html", "degraded"),
    (200, '<title>AVALAR</title><!-- <header id="mainHeader"> -->', "text/html", "degraded"),
    (200, '<title>AVALAR</title><header id="mainHeader">', "text/plain", "degraded"),
    (302, "moved", "text/html", "degraded"),
    (503, "offline", "text/html", "degraded"),
])
def test_healthy_routes_cannot_hide_a_broken_homepage(code, html, media, expected):
    def transport(request):
        if request.url.path == "/":
            return httpx.Response(code, text=html, headers={"content-type": media})
        return httpx.Response(200, json={"status": request.url.path.split("/")[-1]})
    result = asyncio.run(probe_avalar_health("https://site.test", 2, transport=httpx.MockTransport(transport)))
    assert result.health == expected and result.page_status == code
    if expected == "degraded":
        assert result.error_code == "avalar_page_failed"


def test_private_page_requires_both_current_origin_observations():
    now = datetime.now(timezone.utc).isoformat()
    origin = dict(environment="stage", details_source="live", observed_at=now, details_observed_at=now, application_readiness="ready")
    assert private_stage_status(origin, 60) is None
    assert private_stage_status(dict(origin, page_readiness="not_ready"), 60) == "avalar_page_failed"
    assert private_stage_status(dict(origin, page_readiness="ready"), 60) == "ready"
