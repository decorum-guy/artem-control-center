"""Authorize a Desktop OAuth client in the local browser and protect it on Windows."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import secrets
import subprocess
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from panel_agent.youtube_music import CHANNEL_ID, DATA_API, SCOPE, TOKEN_URL, YOUTUBE_PROXY

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"


def authorize(client: dict[str, str]) -> dict[str, str]:
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    received: dict[str, str] = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:
            pass

        def do_GET(self) -> None:
            target = urlsplit(self.path)
            query = parse_qs(target.query)
            matched = target.path == "/" and query.get("state") == [state]
            if matched:
                if code := query.get("code", [""])[0]:
                    received["code"] = code
                else:
                    received["error"] = "denied"
            self.send_response(200 if matched else 404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write("Можешь закрыть вкладку.".encode() if matched else b"Not found")

    with HTTPServer(("127.0.0.1", 0), Callback) as server:
        server.timeout = 1
        redirect = f"http://127.0.0.1:{server.server_port}/"
        url = AUTH_URL + "?" + urlencode({
            "client_id": client["client_id"], "response_type": "code", "redirect_uri": redirect,
            "state": state, "scope": SCOPE, "access_type": "offline", "prompt": "select_account consent",
            "code_challenge": challenge, "code_challenge_method": "S256",
        })
        if not webbrowser.open(url):
            raise RuntimeError("The local browser was not available")
        deadline = time.monotonic() + 300
        while not received and time.monotonic() < deadline:
            server.handle_request()
    if "code" not in received:
        raise RuntimeError("Authorization not completed")

    with httpx.Client(proxy=YOUTUBE_PROXY, trust_env=False, follow_redirects=False, timeout=8) as http:
        response = http.post(TOKEN_URL, data={
            "grant_type": "authorization_code", "code": received["code"], "code_verifier": verifier,
            "redirect_uri": redirect, "client_id": client["client_id"], "client_secret": client["client_secret"],
        })
        response.raise_for_status()
        token = response.json()
        if not token.get("refresh_token") or SCOPE not in token.get("scope", "").split():
            raise RuntimeError("Consent or offline access is missing")
        response = http.get(DATA_API + "channels", params={"part": "snippet", "mine": "true", "maxResults": 5},
                            headers={"Authorization": "Bearer " + token["access_token"]})
        response.raise_for_status()
        channel, = response.json()["items"]
        handle = channel["snippet"]["customUrl"]
        if not CHANNEL_ID.fullmatch(channel["id"]) or not handle.startswith("@"):
            raise RuntimeError("Single intended YouTube channel with a handle is required")
    print(f"Канал {handle}. Назначение — «Понравившаяся музыка».")
    if input("Сохранить подключение для этого канала [y/N] ").strip().lower() != "y":
        raise RuntimeError("Channel not accepted")
    return {"client_id": client["client_id"], "client_secret": client["client_secret"],
            "refresh_token": token["refresh_token"], "channel_id": channel["id"], "channel_handle": handle}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop_client", type=Path)
    parser.add_argument("vault_directory", type=Path)
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("run in the Windows session that owns the Panel Agent")
    try:
        client = json.loads(args.desktop_client.read_text(encoding="utf-8"))["installed"]
        credential = authorize(client)
        subprocess.run([sys.executable, str(Path(__file__).with_name("station-credential-store.py")),
                        str(args.vault_directory), "--youtube-music"],
                       input=json.dumps(credential).encode(), check=True, timeout=20)
    except (OSError, ValueError, KeyError, RuntimeError, httpx.HTTPError, subprocess.SubprocessError):
        print("Подключение Google не завершено. Проверь тип Desktop, канал и доступ API.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
