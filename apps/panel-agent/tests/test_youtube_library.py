import asyncio
import json
import logging
from pathlib import Path

import pytest
from fastapi import HTTPException

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.music_library import MusicLibrary
from panel_agent.music_library_types import Continuation
from panel_agent.youtube_library import YouTubeLibrary, read_page, verify_browser_account
from panel_agent.youtube_music import (
    GoogleCredential,
    MusicAuthRequired,
    MusicReadDiagnostics,
    MusicUnavailable,
    YOUTUBE_PROXY,
)

ACCOUNT = GoogleCredential("client", "secret", "refresh", "UC" + "A" * 22, "@synthetic_channel")
HEADERS = {
    "cookie": "__Secure-3PAPISID=fixture",
    "authorization": "SAPISIDHASH 123_abc",
    "x-goog-authuser": "0",
    "x-goog-visitor-id": "fixture",
}


def browse_sections(*sections):
    return {"contents": {"singleColumnBrowseResultsRenderer": {"tabs": [{"tabRenderer": {
        "content": {"sectionListRenderer": {"contents": [{"itemSectionRenderer": {"contents": list(sections)}}]}}
    }}]}}}


def grid(*entries, token=None):
    data = {"items": list(entries)}
    if token:
        data["continuations"] = [{"nextContinuationData": {"continuation": token}}]
    return browse_sections({"gridRenderer": data})


def tile(key, page_type=None):
    browse = {"browseId": "VL" + key}
    if page_type:
        browse["browseEndpointContextSupportedConfigs"] = {
            "browseEndpointContextMusicConfig": {"pageType": page_type}
        }
    return {"musicTwoRowItemRenderer": {
        "title": {"runs": [{"text": "Fixture list", "navigationEndpoint": {"browseEndpoint": browse}}]},
        "subtitle": {"runs": [{"text": "Playlist"}]},
    }}


def append(entries):
    return {"onResponseReceivedActions": [{"appendContinuationItemsAction": {"continuationItems": entries}}]}


def next_item(token):
    return {"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": token}}}}


def account_menu(handle="@synthetic_channel"):
    # The active channel identity suffices. Name and photo are decorative.
    header = {"channelHandle": {"runs": [{"text": handle}]}}
    return {"actions": [{"openPopupAction": {"popup": {"multiPageMenuRenderer": {
        "header": {"activeAccountHeaderRenderer": header}
    }}}}]}


def signed_out(payload):
    return {**payload, "responseContext": {"serviceTrackingParams": [
        {"service": "GFEEDBACK", "params": [{"key": "logged_in", "value": "0"}]}
    ]}}


GUEST_MENU = signed_out({"actions": [{"openPopupAction": {"popup": {"multiPageMenuRenderer": {
    "sections": [{"multiPageMenuSectionRenderer": {"items": [{"compactLinkRenderer": {}}]}}]
}}}}]})
GUEST_CATALOG = signed_out(browse_sections({"messageRenderer": {
    "icon": {"iconType": "LIKE"}, "button": {"buttonRenderer": {}}
}}))


class Client:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def _send_request(self, endpoint, body, params=""):
        self.requests.append((endpoint, body, params))
        return self.response


@pytest.mark.parametrize("reply", [
    browse_sections({"messageRenderer": {"text": {"runs": [{"text": "Fixture error"}]}}}),
    grid({"unknownRenderer": {"sensitive": "fixture-private-payload"}}),
    grid(tile("PLgood"), {"unknownRenderer": {}}),
    grid({"continuationItemRenderer": {}}),
    {**grid(), "error": {"message": "Fixture error"}},
])
def test_unrecognized_catalog_is_not_empty(reply):
    with pytest.raises(MusicUnavailable):
        read_page(Client(reply), None, None)


def test_explicit_empty_grid_and_known_create_tile():
    create = {"musicTwoRowItemRenderer": {"navigationEndpoint": {"createPlaylistEndpoint": {}}}}
    for payload in (grid(), grid(create)):
        result = read_page(Client(payload), None, None)
        assert [row.key for row in result.rows] == ["LM"]
        assert result.continuation is None


@pytest.mark.parametrize("payload", [GUEST_MENU, GUEST_CATALOG])
def test_signed_out_response_is_auth_required_even_with_http_200(payload):
    with pytest.raises(MusicAuthRequired):
        if payload is GUEST_MENU:
            verify_browser_account(Client(payload), ACCOUNT, MusicReadDiagnostics())
        else:
            read_page(Client(payload), None, None)


def test_account_uses_only_the_active_handle(caplog):
    log = MusicReadDiagnostics()
    with caplog.at_level(logging.INFO, logger=log.logger.name):
        verify_browser_account(Client(account_menu("@SYNTHETIC_CHANNEL")), ACCOUNT, log)
        with pytest.raises(MusicAuthRequired):
            verify_browser_account(Client(account_menu("@unrelated_channel")), ACCOUNT, log)
        with pytest.raises(MusicUnavailable):
            verify_browser_account(Client(account_menu("")), ACCOUNT, log)
    assert "account_match=True" in caplog.text and "account_match=False" in caplog.text
    assert "@synthetic_channel" not in caplog.text.lower()
    assert "@unrelated_channel" not in caplog.text


def test_catalog_follows_both_supported_continuation_shapes():
    start = read_page(Client(grid(tile("PLfirst"), token="fixture-grid")), None, None)
    assert [row.key for row in start.rows] == ["LM", "PLfirst"]
    assert start.continuation == Continuation("fixture-grid", "grid")
    legacy = Client({"continuationContents": {"gridContinuation": {
        "items": [tile("PLsecond"), next_item("fixture-append")]
    }}})
    middle = read_page(legacy, None, start.continuation)
    assert [row.key for row in middle.rows] == ["PLsecond"]
    assert legacy.requests[0][2]
    assert middle.continuation == Continuation("fixture-append", "append")
    end = read_page(Client(append([tile("PLlast")])), None, middle.continuation)
    assert [row.key for row in end.rows] == ["PLlast"] and end.continuation is None


def test_grid_continuation_recognizes_opaque_id_only_with_playlist_page_type():
    key = "different_family_fixture_playlist"
    continuation = Continuation("fixture-grid", "grid")
    def response(tile):
        return Client({"continuationContents": {"gridContinuation": {"items": [tile]}}})
    recognized = read_page(response(tile(key, "MUSIC_PAGE_TYPE_PLAYLIST")), None, continuation)
    assert [row.key for row in recognized.rows] == [key]
    for page_type in (None, "MUSIC_PAGE_TYPE_ALBUM"):
        with pytest.raises(MusicUnavailable):
            read_page(response(tile(key, page_type)), None, continuation)


def test_tracks_continuation_preserves_an_unavailable_row_and_rejects_unknown_shape():
    client = Client(append([{"musicResponsiveListItemRenderer": {}}, next_item("fixture-track-next")]))
    result = read_page(client, "LM", Continuation("fixture-track", "tracks"))
    assert len(result.rows) == 1 and not result.rows[0].playable
    assert result.continuation == Continuation("fixture-track-next", "tracks")
    with pytest.raises(MusicUnavailable):
        read_page(Client(append([{"messageRenderer": {}}])), "LM", Continuation("fixture-track", "tracks"))


def test_invalid_catalog_refresh_keeps_projected_catalog_and_cursor(tmp_path):

    class Provider:
        response = grid(tile("PLold"), token="fixture-old")

        def version(self):
            return (1,)

        def reset(self):
            pass

        async def catalog(self, continuation):
            return read_page(Client(self.response), None, continuation)

        async def tracks(self, source, continuation):
            return read_page(Client(append([])), source, Continuation("fixture-tracks", "tracks"))

    async def run():
        provider = Provider()
        policy = AccessPolicyStore(tmp_path / "access.json")
        library = MusicLibrary(None, None, provider, access=lambda: policy, writes=lambda: False,
                               paired_track=lambda _: None)
        first = await library.page("youtube", "", None)
        for bad in (grid({"unknownRenderer": {}}), browse_sections({"messageRenderer": {}})):
            provider.response = bad
            with pytest.raises(HTTPException) as exc:
                await library.page("youtube", "", None, refresh=True)
            assert exc.value.status_code == 503
            assert library.status("youtube")["status"] == "unavailable"
            assert await library.page("youtube", "", None) == first
            assert "PLold" in library.feeds["youtube"].sources
            assert first["next"] in library.feeds["youtube"].cursors
            await library.page("youtube", "PLold", None, refresh=True)
            assert library.status("youtube")["status"] == "unavailable"
        provider.response = grid(tile("PLold"), tile("PLnew"))
        recovered = await library.page("youtube", "", None, refresh=True)
        assert [row["key"] for row in recovered["items"]] == ["LM", "PLold", "PLnew"]
        assert library.status("youtube")["status"] == "ready"

    asyncio.run(run())


def test_account_is_checked_on_start_after_ttl_and_on_new_client_instance(monkeypatch, caplog):
    from contextlib import contextmanager
    from panel_agent import youtube_library

    class TimedClient:
        def _send_request(self, endpoint, body):
            events.append(endpoint)
            return account_menu() if endpoint == "account/account_menu" else grid(tile("PLfixture"))

    @contextmanager
    def http(*args, **kwargs):
        yield TimedClient()

    events = []
    clock = [50.0]
    monkeypatch.setattr(youtube_library.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(youtube_library, "music_http", http)
    monkeypatch.setattr(youtube_library, "read_browser_vault", lambda path: json.dumps(
        HEADERS if path == Path("browser") else vars(ACCOUNT)
    ).encode())
    monkeypatch.setattr(YouTubeLibrary, "credential_revision", lambda self: ((1,), (1,)))

    def provider():
        return YouTubeLibrary(Path("browser"), Path("oauth"), YOUTUBE_PROXY)

    instance = provider()
    with caplog.at_level(logging.INFO, logger=MusicReadDiagnostics.logger.name):
        for seconds in (0, 119, 1):
            clock[0] += seconds
            assert instance._read(None, None).rows[1].key == "PLfixture"
        provider()._read(None, None)
    assert events == ["account/account_menu", "browse", "browse",
                      "account/account_menu", "browse", "account/account_menu", "browse"]
    assert "phase=account_menu container=activeAccountHeaderRenderer" in caplog.text
    assert "phase=catalog_first container=gridRenderer" in caplog.text


@pytest.mark.parametrize(("outcome", "code", "expected"), [
    ("consent", "consent_redirect", MusicUnavailable),
    ("upstream", "upstream_http", MusicUnavailable),
    ("network", "transport", MusicUnavailable),
    ("signedout", "ok", MusicAuthRequired),
])
def test_browser_transport_logs_sanitized_phase_status_and_errors(monkeypatch, caplog, outcome, code, expected):
    import requests
    from panel_agent.youtube_music import music_http

    def send(self, method, url, **kwargs):
        assert kwargs["proxies"] == {"https": YOUTUBE_PROXY}
        assert kwargs["allow_redirects"] is False
        if outcome == "network":
            raise requests.ConnectionError("fixture-private-payload")
        response = requests.Response()
        response.status_code = {"consent": 303, "upstream": 503, "signedout": 200}[outcome]
        response.headers["Content-Type"] = "application/json; fixture-private-payload"
        if outcome == "consent":
            response.headers["Location"] = "https://consent.youtube.com/?private=fixture-private-payload"
        response._content = json.dumps(GUEST_MENU).encode()
        response._content_consumed = True
        return response

    monkeypatch.setattr(requests.Session, "request", send)
    log = MusicReadDiagnostics()
    with caplog.at_level(logging.INFO, logger=log.logger.name), pytest.raises(expected):
        with music_http(YOUTUBE_PROXY, json.dumps(HEADERS), diagnostics=log) as client:
            with log.step("account_menu"):
                verify_browser_account(client, ACCOUNT, log)
    assert f"phase=account_menu code={code}" in caplog.text
    assert "phase=client_init result=ok" in caplog.text
    assert "fixture-private-payload" not in caplog.text
