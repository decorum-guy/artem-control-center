"""Use the dedicated Samsung Edge profile to authorize read-only YouTube Music."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import urlsplit

from .station_credentials import write_protected
from .youtube_library import BrowserChannelMismatch, YouTubeLibrary, read_page, verify_browser_account
from .youtube_library_credentials import VISITOR_VALUE, browser_headers
from .youtube_music import MusicAuthRequired, MusicReadDiagnostics, MusicUnavailable, YOUTUBE_PROXY, music_http

ORIGIN = "https://music.youtube.com"
PROFILE_DIRECTORY = "music-edge-profile"
LOGIN_HOSTS = {"accounts.google.com", "consent.google.com", "consent.youtube.com"}
CONNECT_CAPABILITY = "media.youtube.connect_browser"
MANUAL_TIMEOUT = 180
RECOVERY_TIMEOUT = 30
AUTH_COOKIES = frozenset({
    "SID", "HSID", "SSID", "APISID", "SAPISID", "SIDCC", "LOGIN_INFO",
    "__Secure-1PSID", "__Secure-1PAPISID", "__Secure-1PSIDTS", "__Secure-1PSIDCC",
    "__Secure-3PSID", "__Secure-3PAPISID", "__Secure-3PSIDTS", "__Secure-3PSIDCC",
})

# The application itself supplies the active account index. Nothing is collected
# on Google sign-in pages or from any other browser profile.
MUSIC_SIGN_IN_STATE = """() => {
    const config = window.ytcfg;
    const signedIn = config?.get('LOGGED_IN');
    return typeof signedIn === 'boolean' ? {
        signedIn,
        index: String(config.get('SESSION_INDEX') ?? ''),
        visitor: config.get('VISITOR_DATA') ?? ''
    } : null;
}"""


class BrowserConnectionChanged(Exception):
    pass


def capture_session(state: dict, cookies: list[dict]) -> bytes:
    from ytmusicapi.helpers import get_authorization, sapisid_from_cookie

    # cookies() is scoped to the single destination below. Retain only what
    # the browser provides for that destination and the active account hint.
    cookie = "; ".join(f"{entry['name']}={entry['value']}" for entry in cookies if entry["name"] in AUTH_COOKIES)
    signed = get_authorization(sapisid_from_cookie(cookie) + " " + ORIGIN)
    index = state["index"]
    headers = {"cookie": cookie, "authorization": signed, "x-goog-authuser": index or "0"}
    visitor = state.get("visitor")
    if isinstance(visitor, str) and VISITOR_VALUE.fullmatch(visitor):
        headers["x-goog-visitor-id"] = visitor
    result = json.dumps(headers).encode()
    browser_headers(result)
    return result


async def browse_for_session(
    profile: Path,
    manual: bool,
    approve: Callable[[bytes], Awaitable[bool]],
    report: Callable[[str], None],
) -> None:
    from playwright.async_api import Error as BrowserError, async_playwright

    async with async_playwright() as driver:
        context = await driver.chromium.launch_persistent_context(
            str(profile), channel="msedge", headless=not manual, proxy={"server": YOUTUBE_PROXY},
            accept_downloads=False, args=["--disable-quic"], timeout=15_000,
        )
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=16_000)
            reviewed: set[bytes] = set()
            while not page.is_closed():
                location = urlsplit(page.url)
                if location.scheme == "https" and location.hostname in LOGIN_HOSTS:
                    report("sign_in")
                    if not manual:
                        raise MusicAuthRequired
                elif location.scheme == "https" and location.netloc == "music.youtube.com":
                    try:
                        state = await page.evaluate(MUSIC_SIGN_IN_STATE)
                    except BrowserError:
                        # A normal navigation during Google sign-in replaces the JS context.
                        state = None
                    if state and state["signedIn"] is False:
                        report("sign_in")
                        if not manual:
                            raise MusicAuthRequired
                    elif state and state["signedIn"] is True:
                        try:
                            candidate = capture_session(state, await context.cookies(ORIGIN + "/youtubei/v1/browse"))
                        except (KeyError, TypeError, ValueError):
                            if not manual:
                                raise MusicAuthRequired from None
                            report("sign_in")
                            await asyncio.sleep(.75)
                            continue
                        # The request signature is time dependent. Count unique cookie/account
                        # combinations, so a mismatch cannot cause a loop of network attempts.
                        fields = browser_headers(candidate)
                        marker = hashlib.sha256((fields["x-goog-authuser"] + "\n" + fields["cookie"]).encode()).digest()
                        if marker not in reviewed:
                            if len(reviewed) == 4:
                                raise MusicAuthRequired
                            reviewed.add(marker)
                            if await approve(candidate):
                                return
                            if not manual:
                                raise MusicAuthRequired
                await asyncio.sleep(.75)
            raise BrowserConnectionChanged
        finally:
            # Normally closing the context flushes the profile and closes
            # only this Edge tree. Driver teardown is the bounded fallback.
            try:
                await asyncio.wait_for(context.close(), timeout=6)
            except (BrowserError, TimeoutError):
                pass


class MusicBrowserConnector:
    def __init__(self, library: YouTubeLibrary, allowed: Callable[[], bool], *,
                 browser=browse_for_session):
        self.library = library
        self.allowed = allowed
        self.browser = browser
        self.profile = library.path.parent / PROFILE_DIRECTORY
        self.task: asyncio.Task | None = None
        self.state = "idle"
        self.recovery: tuple | None = None
        self.closed = False

    @classmethod
    def from_environment(cls, library: YouTubeLibrary | None, allowed: Callable[[], bool]):
        if library and sys.platform == "win32" and os.getenv("PANEL_YOUTUBE_BROWSER_CONNECT_ENABLED") == "true":
            return cls(library, allowed)
        return None

    def projection(self) -> dict:
        return {"available": not self.closed, "state": self.state,
                "active": self.task is not None and not self.task.done(),
                "canConnect": self.allowed() and not self.closed}

    def recover(self) -> None:
        versions = self.library.version()
        if versions and self.profile.is_dir() and versions != self.recovery:
            if self.start(manual=False):
                self.recovery = versions
        elif self.state == "idle":
            self.state = "auth_required"

    def confirm_read(self, version: tuple | None) -> None:
        # Candidate validation is part of the attempt. A subsequent provider
        # read by the library closes the incident for that exact vault version.
        if (version and self.recovery == version
                and (self.state == "connected" or self.task is None or self.task.done())):
            self.recovery = None

    def start(self, *, manual: bool) -> bool:
        if self.closed or not self.allowed() or (self.task is not None and not self.task.done()):
            return False
        self.state = "opening" if manual else "recovering"
        self.task = asyncio.create_task(self._run(manual), name="youtube-music-browser-connection")
        return True

    def _report(self, state: str) -> None:
        self.state = state

    def _validate(self, candidate: bytes, official) -> None:
        auth = browser_headers(candidate)
        diagnostics = MusicReadDiagnostics()
        with music_http(self.library.proxy, json.dumps(auth), request_limit=4, byte_limit=10_485_760,
                        diagnostics=diagnostics) as client:
            with diagnostics.step("account_menu"):
                verify_browser_account(client, official, diagnostics)
            with diagnostics.step("catalog_first"):
                read_page(client, None, None, diagnostics)

    async def _run(self, manual: bool) -> None:
        try:
            if (self.library.proxy != YOUTUBE_PROXY or not self.profile.is_absolute()
                    or self.profile.parent.name != "station-credentials"
                    or self.profile.resolve().parent != self.profile.parent.resolve()):
                raise MusicUnavailable
            original = self.library.credential_revision()
            official = self.library.official_account()

            async def approve(candidate: bytes) -> bool:
                self.state = "verifying"
                try:
                    await asyncio.to_thread(self._validate, candidate, official)
                except BrowserChannelMismatch:
                    self.state = "wrong_channel"
                    return False
                if not self.allowed() or self.library.credential_revision() != original:
                    raise BrowserConnectionChanged
                write_protected(self.library.path, candidate)
                if not manual:
                    self.recovery = self.library.version()
                self.state = "connected"
                return True

            async with asyncio.timeout(MANUAL_TIMEOUT if manual else RECOVERY_TIMEOUT):
                await self.browser(self.profile, manual, approve, self._report)
        except asyncio.CancelledError:
            self.state = "cancelled"
            raise
        except BrowserConnectionChanged:
            self.state = "cancelled"
        except MusicAuthRequired:
            if self.state != "wrong_channel":
                self.state = "auth_required"
        except TimeoutError:
            self.state = "timed_out" if manual else "unavailable"
        except Exception:
            # Never log Playwright errors, which can contain URLs from sign-in.
            self.state = "unavailable"

    async def cancel(self) -> None:
        if self.task is not None and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.state = "cancelled"

    async def close(self) -> None:
        self.closed = True
        await self.cancel()
