import asyncio
import json

import httpx

from panel_agent.alice_voice_feedback import AliceVoiceFeedback
from panel_agent.home_assistant import HomeAssistantAdapter
from panel_agent.settings import IntegrationSettings

STATION = "media_player.mini"


def test_feedback_uses_text_playback_and_varies_confirmations():
    async def check():
        received = []

        def on_request(request):
            assert request.url.path == "/api/services/media_player/play_media"
            assert request.method == "POST"
            received.append(json.loads(request.content))
            return httpx.Response(200, json=[])

        service = HomeAssistantAdapter(IntegrationSettings(ha_url="http://127.0.0.1:8123", ha_token="test"),
                                       transport=httpx.MockTransport(on_request))
        feedback = AliceVoiceFeedback(service.speak_on_station)
        for _ in range(3):
            feedback.announce(STATION, "tv.screen-off.screen-confirmed", lambda: True)
            await feedback.task
        feedback.announce(STATION, "music.youtube_like", lambda: True)
        await feedback.task
        assert received == [
            {"entity_id": STATION, "media_content_type": "text", "media_content_id": phrase}
            for phrase in ("Экран погашен.", "Экран выключен.", "Экран погашен.", "Лайк подтверждён.")
        ]
        await feedback.close()

    asyncio.run(check())


def test_feedback_skips_busy_results_rechecks_policy_and_closes():
    async def check():
        sent = []
        started = asyncio.Event()
        release = asyncio.Event()
        permitted = True

        async def speak(entity, phrase):
            sent.append((entity, phrase))
            started.set()
            await release.wait()

        def allowed():
            return permitted

        feedback = AliceVoiceFeedback(speak)
        feedback.announce(STATION, "music.working", allowed)
        assert feedback.task is None
        feedback.announce(STATION, "music.in_music", allowed)
        permitted = False
        await feedback.task
        assert not sent

        permitted = True
        feedback.announce(STATION, "music.youtube_like", allowed)
        await started.wait()
        in_progress = feedback.task
        feedback.announce(STATION, "tv.offline", allowed)
        assert feedback.task is in_progress
        await feedback.close()
        assert in_progress.cancelled()
        feedback.announce(STATION, "tv.unconfirmed", allowed)
        assert feedback.task is None and sent == [(STATION, "Лайк подтверждён.")]

    asyncio.run(check())
