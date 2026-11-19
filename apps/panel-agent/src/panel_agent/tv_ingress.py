"""Standalone loopback PWA ingress. Publish only through a private HTTPS forward."""
from __future__ import annotations

import argparse
import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import ipaddress
import mimetypes
from pathlib import Path
import secrets
import sqlite3
import ssl
from threading import Lock
import time
from urllib.parse import urlsplit

from .tv_api import TVCommand, TVExecutorClient

COOKIE = "cc_tv"
LIFETIME = 30 * 86400
STATIC = {"manifest.webmanifest", "icon-192.png", "icon-512.png", "sw.js"}


class Sessions:
    def __init__(self, path: Path):
        self.path = path
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER)")

    @staticmethod
    def digest(value: str):
        return hashlib.sha256(value.encode()).hexdigest()

    def create(self) -> str:
        now = int(time.time())
        token = secrets.token_urlsafe(32)
        with sqlite3.connect(self.path) as connection:
            connection.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
            connection.execute("INSERT INTO sessions VALUES (?,?)", (self.digest(token), now + LIFETIME))
        return token

    def authorized(self, token: str) -> bool:
        if not token:
            return False
        with sqlite3.connect(self.path) as connection:
            return connection.execute("SELECT 1 FROM sessions WHERE hash=? AND expires>?",
                                      (self.digest(token), int(time.time()))).fetchone() is not None

    def revoke(self, token: str):
        with sqlite3.connect(self.path) as connection:
            connection.execute("DELETE FROM sessions WHERE hash=?", (self.digest(token),))

    def revoke_all(self):
        with sqlite3.connect(self.path) as connection:
            connection.execute("DELETE FROM sessions")


def remote_assets(dist: Path) -> set[str]:
    manifest = json.loads((dist / ".vite/manifest.json").read_text(encoding="utf-8"))
    pending = ["remote/index.html"]
    visited: set[str] = set()
    files = set()
    while pending:
        entry = pending.pop()
        if entry in visited:
            continue
        visited.add(entry)
        item = manifest[entry]
        files.update([item["file"], *item.get("css", []), *item.get("assets", [])])
        pending.extend([*item.get("imports", []), *item.get("dynamicImports", [])])
    return {"/" + value for value in files if value.startswith("assets/")}


def build_handler(dist: Path, sessions: Sessions, pairing: str, origin: str, executor: TVExecutorClient):
    def local_origin(value: str) -> bool:
        parsed = urlsplit(value)
        return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}

    # Production swaps dist atomically. Build identity and allowlist refresh together.
    manifest_lock = Lock()
    manifest_epoch = None
    assets: set[str] = set()
    login_lock = Lock()
    attempts: list[float] = []

    def allowed_assets():
        nonlocal manifest_epoch, assets
        with manifest_lock:
            stamp = (dist / ".vite/manifest.json").stat().st_mtime_ns
            if stamp != manifest_epoch:
                assets = remote_assets(dist)
                manifest_epoch = stamp
            return assets

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(6)
            super().setup()

        def log_message(self, *_):
            pass

        def respond(self, code, body, media="application/json", cookie=None):
            payload = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", media)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            if cookie:
                self.send_header("Set-Cookie", cookie)
            self.end_headers()
            self.wfile.write(payload)

        def token(self):
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get("Cookie", ""))
            except CookieError:
                return ""
            return cookie[COOKIE].value if COOKIE in cookie else ""

        def body(self):
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192 or self.headers.get("Transfer-Encoding"):
                raise ValueError("Bad length")
            result = json.loads(self.rfile.read(length))
            if not isinstance(result, dict):
                raise ValueError("Object required")
            return result

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/remote/api/status":
                if not sessions.authorized(self.token()):
                    self.respond(401, {"outcome": "unauthorized"})
                else:
                    self.respond(*executor.invoke())
                return
            if path == "/remote/":
                file = dist / "remote/index.html"
            elif path.removeprefix("/remote/") in STATIC and path.startswith("/remote/"):
                file = dist / path.lstrip("/")
            elif path.startswith("/assets/"):
                try:
                    file = dist / path.lstrip("/") if path in allowed_assets() else None
                except (ValueError, OSError, KeyError):
                    file = None
            else:
                file = None
            if not file or not file.is_file():
                self.respond(404, {"outcome": "unknown"})
                return
            media = {"js": "text/javascript", "webmanifest": "application/manifest+json"}.get(
                file.suffix[1:], mimetypes.guess_type(file)[0] or "application/octet-stream",
            )
            self.respond(200, file.read_bytes(), media)

        def do_POST(self):
            supplied_origin = self.headers.get("Origin", "")
            dev_local = not origin and local_origin(supplied_origin) and urlsplit(supplied_origin).netloc == self.headers.get("Host")
            if (not dev_local and (not origin or supplied_origin != origin)) or self.headers.get("X-Panel-TV") != "1":
                self.respond(403, {"outcome": "forbidden"})
                return
            try:
                body = self.body()
                if self.path == "/remote/api/login":
                    code = body.get("code")
                    with login_lock:
                        now = time.monotonic()
                        attempts[:] = [at for at in attempts if now - at < 60]
                        if len(attempts) >= 8:
                            self.respond(429, {"outcome": "rate-limited"})
                            return
                        if not isinstance(code, str) or not hmac.compare_digest(pairing.encode(), code.encode()):
                            attempts.append(now)
                            self.respond(401, {"outcome": "unauthorized"})
                            return
                    cookie = f"{COOKIE}={sessions.create()}; Path=/remote/; Max-Age={LIFETIME}; HttpOnly; SameSite=Strict"
                    self.respond(200, {"outcome": "signed-in"}, cookie=cookie + ("; Secure" if origin else ""))
                    return
                if self.path not in {"/remote/api/logout", "/remote/api/command"}:
                    self.respond(404, {"outcome": "unknown"})
                    return
                if not sessions.authorized(self.token()):
                    self.respond(401, {"outcome": "unauthorized"})
                    return
                if self.path == "/remote/api/logout":
                    sessions.revoke(self.token())
                    cookie = f"{COOKIE}=; Path=/remote/; Max-Age=0; HttpOnly; SameSite=Strict"
                    self.respond(200, {"outcome": "signed-out"}, cookie=cookie + ("; Secure" if origin else ""))
                else:
                    self.respond(*executor.invoke(TVCommand.model_validate(body)))
            except (ValueError, TimeoutError):
                self.respond(400, {"outcome": "invalid"})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--revoke-all", action="store_true")
    parser.add_argument("--dist", type=Path)
    parser.add_argument("--pairing-file", type=Path)
    parser.add_argument("--executor-token-file", type=Path)
    parser.add_argument("--port", type=int, default=38456)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    parser.add_argument("--origin", default="", help="complete private HTTPS origin")
    args = parser.parse_args()
    sessions = Sessions(args.state)
    if args.revoke_all:
        sessions.revoke_all()
        return
    if not args.dist or not args.pairing_file or not args.executor_token_file:
        parser.error("dist, pairing-file and executor-token-file are required to serve")
    if args.origin:
        origin = urlsplit(args.origin)
        if origin.scheme != "https" or not origin.hostname or origin.username or origin.path or origin.query or origin.fragment:
            parser.error("origin must be an HTTPS origin with no path")
    pairing = args.pairing_file.read_text(encoding="utf-8-sig").strip()
    if len(pairing) < 32:
        parser.error("pairing must have at least 32 characters")
    handler = build_handler(args.dist.resolve(), sessions, pairing, args.origin, TVExecutorClient(args.executor_token_file))
    address = ipaddress.IPv4Address(args.bind)
    if not address.is_loopback and (not address.is_private or not args.origin or not args.cert or not args.key):
        parser.error("Non-loopback ingress requires private IPv4, HTTPS origin and a certificate")
    if bool(args.cert) != bool(args.key):
        parser.error("Specify both certificate and private key")
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        if args.cert:
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.minimum_version = ssl.TLSVersion.TLSv1_2
            tls.load_cert_chain(args.cert, args.key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
