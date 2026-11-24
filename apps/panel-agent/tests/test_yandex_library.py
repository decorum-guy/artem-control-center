import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from panel_agent.music_library import MusicLibrary, PlaySelection
from panel_agent.station_playback import StationPlaybackCollector
from panel_agent.yandex_library import YandexLibrary, YandexPageExpired
from panel_agent.youtube_music import MusicUnavailable


def playlist(owner, kind, *, title="Одно название", cover=None):
    return {"owner": {"uid": owner}, "kind": kind, "title": title, "trackCount": 45,
            "cover": {"uri": cover}}


class FixtureYandex(YandexLibrary):
    def __init__(self):
        self.credential = 1
        super().__init__(SimpleNamespace(version=lambda: (self.credential,)))
        self.own = [playlist(12, 4, cover="avatars.yandex.net/get-music-user-playlist/1/x/%%")]
        self.liked = [{"playlist": playlist(12, 4)}, {"playlist": playlist(34, 4)}]
        self.rows = {
            "/users/12/playlists/4": [{"id": "1", "albumId": "5"}, {"id": "1:6"}] +
            [{"id": "1:5"}] * 37 + [None, {"id": "2"}],
            "/users/34/playlists/4": [{"id": "3"}] * 45,
        }
        self.calls = []
        self.fail_catalog = False

    async def _authorize(self):
        if self.context != self.version():
            self.reset()
            self.context = self.version()

    async def _request(self, method, path, **kwargs):
        await self._authorize()
        self.calls.append((method, path, kwargs))
        if path == "/account/status":
            return {"account": {"uid": 12}}
        if path.endswith("/playlists/list"):
            return self.own
        if path.endswith("/likes/playlists"):
            if self.fail_catalog:
                raise MusicUnavailable
            return self.liked
        if path.endswith("/likes/tracks"):
            return {"library": {"tracks": [{"id": "4"}]}}
        if path == "/tracks":
            rows = []
            for item in kwargs["data"]["track-ids"].split(","):
                track, _, album = item.partition(":")
                rows.append({"id": track, "title": f"Песня {item}", "available": track != "2",
                             "albums": [{"id": album, "title": album}] if album else []})
            return rows
        return {"tracks": self.rows[path]}


def test_yandex_catalog_keeps_owner_identity_covers_and_likes():
    async def run():
        adapter = FixtureYandex()
        catalog = await adapter.catalog(None)
        assert [row.key for row in catalog.rows] == ["likes", "ya_12_4", "ya_34_4"]
        first, second = catalog.rows[1:]
        assert first.title == second.title
        assert first.artwork == "https://avatars.yandex.net/get-music-user-playlist/1/x/200x200"
        assert second.artwork is None
        assert not any(path in adapter.rows for _, path, _ in adapter.calls)

    asyncio.run(run())


def test_yandex_indexes_follow_order_and_version_across_sources():
    async def run():
        adapter = FixtureYandex()
        first = await adapter.tracks("ya_12_4", None)
        other = await adapter.tracks("ya_34_4", None)
        assert len(first.rows) == len(other.rows) == 40
        assert [row.album_id for row in first.rows[:3]] == ["5", "6", "5"]
        assert [row.title for row in first.rows[:3]] == ["Песня 1:5", "Песня 1:6", "Песня 1:5"]
        assert not first.rows[-1].playable
        assert (await adapter.tracks("likes", None)).rows[0].track_id == "4"
        after = await adapter.tracks("ya_12_4", first.continuation)
        assert len(after.rows) == 1 and after.rows[0].track_id == "2"
        assert not after.rows[0].playable and after.continuation is None
        await adapter.tracks("ya_12_4", None)
        with pytest.raises(YandexPageExpired):
            await adapter.tracks("ya_12_4", first.continuation)
        adapter.credential += 1
        with pytest.raises(YandexPageExpired):
            await adapter.tracks("ya_34_4", other.continuation)

    asyncio.run(run())


def test_catalog_refresh_preserves_last_good_and_clears_removed_source(tmp_path):
    from panel_agent.access_policy import AccessPolicyStore

    class Station(StationPlaybackCollector):
        async def play_track(self, track_id, may_send):
            assert track_id == "3"
            assert may_send()
            return "playing"

    async def run():
        adapter = FixtureYandex()
        policy = AccessPolicyStore(tmp_path / "access.json")
        policy.set_profile("standard")
        store = MusicLibrary(Station(None), adapter, None, access=lambda: policy,
                             writes=lambda: True, paired_track=lambda _: None)
        original = await store.page("yandex", "", None)
        tracks = await store.page("yandex", "ya_34_4", None)
        selected = PlaySelection(generation=tracks["generation"], source="ya_34_4", row=tracks["items"][0]["key"])
        assert (await store.play("yandex", selected))["status"] == "playing"
        adapter.fail_catalog = True
        with pytest.raises(HTTPException, match="source_unavailable"):
            await store.page("yandex", "", None, refresh=True)
        assert await store.page("yandex", "", None) == original
        adapter.fail_catalog = False
        adapter.own = [playlist(12, 4, title="Новое название")]
        adapter.liked = []
        updated = await store.page("yandex", "", None, refresh=True)
        assert [item["key"] for item in updated["items"]] == ["likes", "ya_12_4"]
        assert updated["items"][1]["title"] == "Новое название"
        with pytest.raises(HTTPException, match="row_expired"):
            await store.play("yandex", selected)

    asyncio.run(run())
