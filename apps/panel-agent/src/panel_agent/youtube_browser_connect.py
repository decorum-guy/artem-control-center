"""Use the dedicated Samsung Edge profile to authorize read-only YouTube Music."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from collections.abc import Awaitable, Callable
from functools import partial
from pathlib import Path
from urllib.parse import urlsplit

from .station_credentials import write_protected
from .youtube_library import BrowserChannelMismatch, YouTubeLibrary, read_page, verify_browser_account
from .youtube_library_credentials import VISITOR_VALUE, browser_headers
from .youtube_login_window import YouTubeLoginWindow
from .youtube_music import MusicAuthRequired, MusicReadDiagnostics, MusicUnavailable, YOUTUBE_PROXY, music_http

ORIGIN = "https://music.youtube.com"
PROFILE_DIRECTORY = "music-edge-profile"
LOGIN_HOSTS = {"accounts.google.com", "consent.google.com", "consent.youtube.com"}
CONNECT_CAPABILITY = "media.youtube.connect_browser"
MANUAL_TIMEOUT = 600
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


def installed_edge() -> Path:
    for key in ("ProgramFiles(x86)", "ProgramFiles"):
        root = os.environ.get(key)
        if root:
            path = Path(root) / "Microsoft" / "Edge" / "Application" / "msedge.exe"
            if path.is_file():
                return path
    raise MusicUnavailable


async def sign_in_normally(
    profile: Path, report: Callable[[str], None], window: YouTubeLoginWindow,
) -> None:
    # No automation/debugging session during interactive Google sign-in.
    browser = await asyncio.create_subprocess_exec(
        str(installed_edge()), f"--user-data-dir={profile}", f"--proxy-server={YOUTUBE_PROXY}",
        "--disable-quic", "--disable-background-mode", "--no-first-run", "--new-window",
        ORIGIN + "/", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    window.process = browser
    report("sign_in")
    try:
        await window.show_on_open()
        if await browser.wait() != 0:
            raise MusicUnavailable
    finally:
        window.process = None
        if browser.returncode is None:
            # This PID belongs to the isolated Edge instance we just opened.
            cleanup = await asyncio.create_subprocess_exec(
                "taskkill.exe", "/PID", str(browser.pid), "/T", "/F",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            await cleanup.wait()
            await browser.wait()


async def browse_for_session(
    profile: Path,
    manual: bool,
    approve: Callable[[bytes], Awaitable[bool]],
    report: Callable[[str], None],
    *,
    window: YouTubeLoginWindow,
) -> None:
    from playwright.async_api import Error as BrowserError, async_playwright

    if manual:
        await sign_in_normally(profile, report, window)
    report("verifying")
    async with async_playwright() as driver:
        context = await driver.chromium.launch_persistent_context(
            str(profile), channel="msedge", headless=True, proxy={"server": YOUTUBE_PROXY},
            accept_downloads=False, args=["--disable-quic"], timeout=15_000,
        )
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(ORIGIN + "/", wait_until="domcontentloaded", timeout=16_000)
            async with asyncio.timeout(8):
                # Only Music's own account hint is evaluated in this phase.
                # A Google sign-in redirect requires the ordinary window again.
                while not page.is_closed():
                    location = urlsplit(page.url)
                    if location.scheme == "https" and location.hostname in LOGIN_HOSTS:
                        raise MusicAuthRequired
                    if location.scheme == "https" and location.netloc == "music.youtube.com":
                        try:
                            state = await page.evaluate(MUSIC_SIGN_IN_STATE)
                        except BrowserError:
                            state = None
                        if state is not None:
                            if not state["signedIn"]:
                                raise MusicAuthRequired
                            try:
                                candidate = capture_session(state, await context.cookies(ORIGIN + "/youtubei/v1/browse"))
                            except (KeyError, TypeError, ValueError):
                                raise MusicAuthRequired from None
                            break
                    await asyncio.sleep(.25)
                else:
                    raise BrowserConnectionChanged
            if not await approve(candidate):
                raise MusicAuthRequired
        finally:
            # Normally closing the context flushes the profile and closes
            # only this Edge tree. Driver teardown is the bounded fallback.
            try:
                await asyncio.wait_for(context.close(), timeout=6)
            except (BrowserError, TimeoutError):
                pass


class MusicBrowserConnector:
    def __init__(self, library: YouTubeLibrary, allowed: Callable[[], bool], *,
                 browser=None):
        self.library = library
        self.allowed = allowed
        self.window = YouTubeLoginWindow(lambda: self.allowed() and not self.closed)
        self.browser = browser if browser is not None else partial(browse_for_session, window=self.window)
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
                "canConnect": self.allowed() and not self.closed,
                "canFocus": not self.closed and self.allowed() and self.window.find() is not None}

    async def focus(self) -> bool:
        return not self.closed and await self.window.show()

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
