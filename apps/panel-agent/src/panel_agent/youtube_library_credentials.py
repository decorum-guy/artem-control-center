"""Narrow input for ytmusicapi's documented browser authentication."""

from __future__ import annotations

import json
import re
from urllib.parse import urlsplit

KEYS = {"cookie", "authorization", "x-goog-authuser"}


def browser_headers(value: bytes) -> dict[str, str]:
    source = json.loads(value)
    if (not isinstance(source, dict) or source.keys() != KEYS
            or any(not isinstance(field, str) or not field or "\r" in field or "\n" in field
                   for field in source.values())
            or len(source["cookie"]) > 13_000
            or not re.search(r"(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=", source["cookie"])
            or not re.fullmatch(r"SAPISIDHASH [\w ]+(?:[ -][\w-]+)*", source["authorization"])
            or len(source["authorization"]) > 1024
            or not re.fullmatch(r"[0-9]{1,3}", source["x-goog-authuser"])):
        raise ValueError("Invalid Music browser headers")
    return {**source, "accept": "*/*", "content-type": "application/json",
            "origin": "https://music.youtube.com", "x-origin": "https://music.youtube.com"}


def capture_headers(content: bytes) -> bytes:
    """Extract only the three necessary fields from Chromium Copy as fetch (Node.js)."""
    if len(content) > 262_144:
        raise ValueError("Music browser capture exceeds its size limit")
    text = content.decode("utf-8").lstrip()
    match = re.match(r'fetch\s*\(\s*("(?:[^"\\]|\\.)*")', text)
    if match is None:
        raise ValueError("Expected a Chromium fetch capture")
    url = urlsplit(json.loads(match.group(1)))
    if url.scheme != "https" or url.netloc != "music.youtube.com" or url.path != "/youtubei/v1/browse":
        raise ValueError("Expected a YouTube Music browse request")
    options = re.search(r'"headers"\s*:\s*', text[match.end():])
    if options is None:
        raise ValueError("Headers missing")
    raw, _ = json.JSONDecoder().raw_decode(text[match.end() + options.end():])
    if not isinstance(raw, dict):
        raise ValueError("Invalid browser headers")
    selected = {key.lower(): val for key, val in raw.items() if key.lower() in KEYS}
    encoded = json.dumps(selected, ensure_ascii=True).encode()
    browser_headers(encoded)
    return encoded
