from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from panel_agent import coffee_upload_ingress as ingress
from panel_agent.coffee_diary_upload import MAX_UPLOAD_BYTES
from panel_agent.coffee_upload_ingress import MAX_INGRESS_RESPONSE_BYTES


def test_ingress_serves_only_the_minimal_page_and_fixed_upload_post(monkeypatch):
    seen: dict[str, object] = {}

    def upstream(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["token"] = request.headers.get("X-Coffee-Upload-Token")
        seen["content_type"] = request.headers.get("Content-Type")
        seen["body"] = request.content
        return httpx.Response(
            200,
            json={"state": "consumed", "photoId": "11111111-1111-4111-8111-111111111111", "pendingAttachmentId": None},
            request=request,
        )

    transport = httpx.MockTransport(upstream)
    monkeypatch.setattr(ingress, "COFFEE_UPLOAD_UPSTREAM_URL", "http://127.0.0.1:8787/api/v1/coffee-diary/photo-upload")
    app = ingress.create_app(client_factory=lambda: httpx.AsyncClient(transport=transport))

    with TestClient(app) as client:
        page = client.get("/coffee-upload")
        assert page.status_code == 200
        assert page.headers["cache-control"] == "no-store"
        assert page.headers["referrer-policy"] == "no-referrer"
        assert "X-Coffee-Upload-Token" in page.text
        assert "/api/v1/snapshot" not in page.text
        assert client.get("/").status_code == 404
        assert client.get("/api/v1/snapshot").status_code == 404
        assert client.get("/assets/index.js").status_code == 404
        assert client.get("/coffee-upload?token=secret").status_code == 404

        response = client.post(
            "/api/v1/coffee-diary/photo-upload",
            headers={"X-Coffee-Upload-Token": "opaque-token-value", "Content-Type": "image/jpeg"},
            content=b"jpeg-bytes",
        )
        assert response.status_code == 200
        assert response.json()["state"] == "consumed"
        assert seen == {
            "url": "http://127.0.0.1:8787/api/v1/coffee-diary/photo-upload",
            "token": "opaque-token-value",
            "content_type": "image/jpeg",
            "body": b"jpeg-bytes",
        }


def test_ingress_bounds_body_and_never_exposes_token_in_initial_page_request(monkeypatch):
    calls = 0

    def factory():
        nonlocal calls
        calls += 1
        return httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"state": "uploaded", "photoId": None, "pendingAttachmentId": "11111111-1111-4111-8111-111111111111"}, request=request)))

    app = ingress.create_app(client_factory=factory)
    with TestClient(app) as client:
        page = client.get("/coffee-upload")
        assert page.status_code == 200
        assert "secret-token" not in page.text
        response = client.post(
            "/api/v1/coffee-diary/photo-upload",
            headers={"Content-Length": str(MAX_UPLOAD_BYTES + 1), "X-Coffee-Upload-Token": "secret-token"},
            content=b"",
        )
        assert response.status_code == 413
        assert response.json() == {"detail": "coffee_diary_upload_file_too_large"}
        assert calls == 0


def test_ingress_bounds_upstream_response(monkeypatch):
    def upstream(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * (MAX_INGRESS_RESPONSE_BYTES + 1), request=request)

    transport = httpx.MockTransport(upstream)
    app = ingress.create_app(client_factory=lambda: httpx.AsyncClient(transport=transport))
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/coffee-diary/photo-upload",
            headers={"X-Coffee-Upload-Token": "opaque-token-value", "Content-Type": "image/jpeg"},
            content=b"jpeg-bytes",
        )
        assert response.status_code == 502
        assert response.json() == {"detail": "coffee_diary_upload_unavailable"}
