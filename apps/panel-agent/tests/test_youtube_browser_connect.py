import asyncio
from types import SimpleNamespace

import pytest

from panel_agent import youtube_browser_connect as browser_module
from panel_agent.youtube_browser_connect import MusicBrowserConnector, capture_session
from panel_agent.youtube_library import BrowserChannelMismatch
from panel_agent.youtube_library_credentials import browser_headers
from panel_agent.youtube_music import MusicAuthRequired, MusicUnavailable, YOUTUBE_PROXY


@pytest.mark.parametrize("cancel", [False, True])
def test_interactive_sign_in_uses_normal_edge_and_cancels_only_its_tree(tmp_path, monkeypatch, cancel):
    async def run():
        entered, closed = asyncio.Event(), asyncio.Event()
        calls = []

        class BrowserProcess:
            pid = 1234
            returncode = None

            async def wait(self):
                entered.set()
                await closed.wait()
                return self.returncode

        process = BrowserProcess()

        async def launch(*args, **kwargs):
            calls.append(args)
            if args[0] == "taskkill.exe":
                assert args[1:] == ("/PID", str(process.pid), "/T", "/F")
                process.returncode = 1
                closed.set()
            return process

        monkeypatch.setattr(browser_module, "installed_edge", lambda: tmp_path / "msedge.exe")
        monkeypatch.setattr(browser_module.asyncio, "create_subprocess_exec", launch)
        monkeypatch.setattr(browser_module.subprocess, "CREATE_NO_WINDOW", 0, raising=False)
        states = []
        command = asyncio.create_task(browser_module.sign_in_normally(tmp_path, states.append))
        await entered.wait()
        assert states == ["sign_in"]
        assert f"--user-data-dir={tmp_path}" in calls[0]
        assert f"--proxy-server={YOUTUBE_PROXY}" in calls[0]
        assert not any("automation" in arg or "debugging" in arg for arg in calls[0])
        if cancel:
            command.cancel()
            with pytest.raises(asyncio.CancelledError):
                await command
        else:
            process.returncode = 0
            closed.set()
            await command
        assert len(calls) == (2 if cancel else 1)

    asyncio.run(run())


def test_browser_capture_uses_only_music_auth_cookies():
    value = capture_session({"index": "2", "visitor": "fixture"}, [
        {"name": "__Secure-3PAPISID", "value": "test"},
        {"name": "PREF", "value": "ignore"},
    ])
    headers = browser_headers(value)
    assert headers["cookie"] == "__Secure-3PAPISID=test"
    assert headers["x-goog-authuser"] == "2"
    assert headers["x-goog-visitor-id"] == "fixture"
    assert headers["authorization"].startswith("SAPISIDHASH ")


@pytest.fixture
def connection(tmp_path, monkeypatch):
    root = tmp_path / "station-credentials"
    root.mkdir()
    vault = root / "music.dpapi"
    vault.write_bytes(b"working")
    policy = SimpleNamespace(allowed=True)
    versions = [("original", "official")]
    library = SimpleNamespace(path=vault, proxy=YOUTUBE_PROXY, official_account=lambda: "channel",
                              version=lambda: versions[0], credential_revision=lambda: versions[0])
    writes = []

    def write(path, candidate):
        assert path == vault
        writes.append(candidate)
        versions[0] = ("renewed", "official")

    monkeypatch.setattr(browser_module, "write_protected", write)
    return library, policy, versions, writes


def test_two_tabs_share_one_browser_and_cancel_closes_it(connection):
    async def run():
        library, policy, _, writes = connection
        entered, closed = asyncio.Event(), asyncio.Event()

        async def browser(profile, manual, approve, report):
            try:
                report("sign_in")
                entered.set()
                await asyncio.Event().wait()
            finally:
                closed.set()

        connector = MusicBrowserConnector(library, lambda: policy.allowed, browser=browser)
        assert connector.start(manual=True)
        await entered.wait()
        assert not connector.start(manual=True)
        policy.allowed = False
        await connector.cancel()
        assert closed.is_set() and not connector.projection()["active"]
        assert connector.state == "cancelled" and not writes
        await connector.close()
        assert not connector.start(manual=True)

    asyncio.run(run())


@pytest.mark.parametrize("failure,expected", [
    (BrowserChannelMismatch, "wrong_channel"),
    (MusicAuthRequired, "auth_required"),
    (MusicUnavailable, "unavailable"),
])
def test_failed_recovery_preserves_vault_and_does_not_retry(connection, failure, expected):
    async def run():
        library, policy, _, writes = connection
        calls = []

        async def browser(profile, manual, approve, report):
            calls.append(manual)
            assert not await approve(b"invalid")
            raise MusicAuthRequired

        def validate(_, __):
            raise failure

        connector = MusicBrowserConnector(library, lambda: policy.allowed, browser=browser)
        connector.profile.mkdir()
        connector._validate = validate
        connector.recover()
        await connector.task
        connector.recover()
        assert calls == [False] and connector.state == expected
        assert not writes and library.path.read_bytes() == b"working"

    asyncio.run(run())


@pytest.mark.parametrize("interruption", ["cancel", "revoke"])
def test_interrupted_automatic_attempt_cannot_write_or_restart(connection, interruption):
    async def run():
        library, policy, _, writes = connection
        entered, release = asyncio.Event(), asyncio.Event()
        launches = []

        async def browser(profile, manual, approve, report):
            launches.append(manual)
            entered.set()
            await release.wait()
            await approve(b"verified")

        connector = MusicBrowserConnector(library, lambda: policy.allowed, browser=browser)
        connector.profile.mkdir()
        connector._validate = lambda candidate, channel: None
        connector.recover()
        await entered.wait()
        if interruption == "cancel":
            await connector.cancel()
        else:
            policy.allowed = False
            release.set()
            await connector.task
            policy.allowed = True
        connector.recover()
        assert launches == [False]
        assert connector.state == "cancelled" and not connector.projection()["active"]
        assert not writes and library.path.read_bytes() == b"working"

    asyncio.run(run())


@pytest.mark.parametrize("changed", [None, "policy", "official"])
def test_rechecks_rights_and_generation_before_replacing_vault(connection, changed):
    async def run():
        library, policy, versions, writes = connection

        async def browser(profile, manual, approve, report):
            if changed == "policy":
                policy.allowed = False
            elif changed == "official":
                versions[0] = ("original", "new-account")
            await approve(b"verified")

        connector = MusicBrowserConnector(library, lambda: policy.allowed, browser=browser)
        connector._validate = lambda _, account: None
        assert connector.start(manual=True)
        await connector.task
        assert writes == ([] if changed else [b"verified"])
        assert connector.state == ("cancelled" if changed else "connected")
        await connector.close()

    asyncio.run(run())
