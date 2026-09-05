"""Minimal LAN ingress for the Coffee Diary mobile photo handoff.

This app is intentionally not a reverse proxy.  It owns exactly one page and
one upload POST, and forwards that fixed POST to the loopback-only Panel Agent
where token, intent, image and storage validation remain canonical.
"""

from __future__ import annotations

import json
import re
from typing import Callable

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

from .coffee_diary_upload import MAX_UPLOAD_BYTES
from .coffee_upload_config import COFFEE_UPLOAD_UPSTREAM_URL, configured_coffee_upload_ingress


MAX_INGRESS_RESPONSE_BYTES = 64 * 1024
_SAFE_ERROR_PATTERN = r"^coffee_diary_upload_[A-Za-z0-9_]{1,96}$"


COFFEE_UPLOAD_PAGE = r"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Фото кофе</title>
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { min-width: 320px; min-height: 100svh; margin: 0; padding: 16px; display: grid; place-items: center; color: #f5eee4; background: #171311; }
main { width: min(100%, 420px); display: grid; gap: 18px; padding: 24px; border: 1px solid rgba(226,177,112,.28); border-radius: 22px; background: #241c18; box-shadow: 0 24px 70px rgba(0,0,0,.35); }
.kicker { margin: 0; color: #d9a768; font-size: 12px; font-weight: 750; letter-spacing: .11em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(30px, 8vw, 42px); line-height: 1; }
p { margin: 0; color: #cbbdb0; line-height: 1.5; }
.controls { display: grid; gap: 12px; }
label, button { min-height: 52px; display: grid; place-items: center; border-radius: 14px; padding: 12px 16px; font: inherit; font-weight: 750; }
label { border: 1px solid #85603d; color: #f5eee4; background: #32251e; cursor: pointer; }
label:focus-within { outline: 3px solid #e2b170; outline-offset: 3px; }
input[type="file"] { position: absolute; width: 1px; height: 1px; opacity: 0; }
button { border: 1px solid #e2b170; color: #23180f; background: #e2b170; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .45; }
img { width: 100%; max-height: 300px; border-radius: 14px; object-fit: contain; background: #130f0d; }
.filename { overflow: hidden; margin-top: -6px; color: #a9988b; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.error { color: #ffad9d; }
.success { display: grid; justify-items: center; gap: 8px; padding: 18px 0 8px; text-align: center; }
.mark { display: grid; width: 64px; height: 64px; place-items: center; border-radius: 50%; color: #23180f; background: #e2b170; font-size: 34px; font-weight: 800; }
</style>
</head>
<body>
<main aria-labelledby="coffee-upload-title">
<p class="kicker">Artem Control Center</p>
<h1 id="coffee-upload-title">Фото кофе</h1>
<section id="success" class="success" hidden role="status" aria-live="polite"><span class="mark" aria-hidden="true">✓</span><p>Фото загружено.</p><p>Можно вернуться к панели.</p></section>
<section id="form" class="controls">
<p>Выберите или сделайте фотографию</p>
<label><span>Выбрать фото</span><input id="file" type="file" accept="image/*" capture="environment"></label>
<img id="preview" alt="Предпросмотр выбранного фото" hidden>
<p id="filename" class="filename" hidden></p>
<button id="submit" type="button" disabled>Загрузить</button>
<p id="error" class="error" role="alert" aria-live="assertive" hidden></p>
</section>
<p id="invalid" class="error" role="alert" hidden>Ссылка недействительна.</p>
</main>
<script>
(function () {
  "use strict";
  var hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  var token = new URLSearchParams(hash).get("token") || "";
  window.history.replaceState({}, "", window.location.pathname);
  var fileInput = document.getElementById("file");
  var preview = document.getElementById("preview");
  var filename = document.getElementById("filename");
  var submit = document.getElementById("submit");
  var error = document.getElementById("error");
  var form = document.getElementById("form");
  var invalid = document.getElementById("invalid");
  var success = document.getElementById("success");
  var file = null;
  var previewUrl = null;

  function errorCopy(code) {
    if (code === "coffee_diary_upload_token_invalid") return "Ссылка недействительна.";
    if (code === "coffee_diary_upload_token_expired") return "Срок действия ссылки истёк.";
    if (code === "coffee_diary_upload_token_cancelled") return "Ссылка отменена на панели.";
    if (code === "coffee_diary_upload_token_consumed") return "Эта ссылка уже использована.";
    if (code === "coffee_diary_upload_file_too_large") return "Файл слишком большой. Выберите фото до 20 МБ.";
    if (code === "coffee_diary_upload_media_type_invalid") return "Этот формат изображения не поддерживается.";
    if (code === "coffee_diary_upload_dimensions_invalid") return "Размер изображения слишком большой.";
    if (code === "coffee_diary_upload_image_invalid") return "Не удалось прочитать изображение. Выберите другое фото.";
    return "Фото не загружено. Повторите попытку.";
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function selectFile(next) {
    if (!next) return;
    file = next;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(next);
    preview.src = previewUrl;
    preview.hidden = false;
    filename.textContent = next.name;
    filename.hidden = false;
    submit.disabled = !token;
    showError("");
  }

  async function upload() {
    if (!token || !file || submit.disabled) return;
    submit.disabled = true;
    submit.textContent = "Загружаем…";
    showError("");
    try {
      var response = await fetch("/api/v1/coffee-diary/photo-upload", {
        method: "POST",
        cache: "no-store",
        headers: { "X-Coffee-Upload-Token": token, "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : "upload_failed");
      form.hidden = true;
      success.hidden = false;
    } catch (reason) {
      submit.disabled = false;
      submit.textContent = "Загрузить";
      showError(reason && reason.message === "Failed to fetch" ? "Ответ сервера не получен. Повторите попытку." : errorCopy(reason && reason.message));
    }
  }

  if (!token) {
    form.hidden = true;
    invalid.hidden = false;
  } else {
    fileInput.addEventListener("change", function () { selectFile(fileInput.files && fileInput.files[0]); });
    submit.addEventListener("click", upload);
  }
}());
</script>
</body>
</html>
"""


def _headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }


def _error(status_code: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status_code, headers=_headers())


async def _read_bounded_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            declared_bytes = int(declared)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid_content_length") from exc
        if declared_bytes < 0:
            raise HTTPException(status_code=400, detail="invalid_content_length")
        if declared_bytes > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="coffee_diary_upload_file_too_large")

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="coffee_diary_upload_file_too_large")
    return bytes(body)


async def _read_bounded_upstream_body(response: httpx.Response) -> bytes | None:
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > MAX_INGRESS_RESPONSE_BYTES:
            return None
    return bytes(body)


def _new_upstream_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(35.0, connect=3.0))


def _safe_upstream_payload(status_code: int, body: bytes) -> dict[str, object] | None:
    if len(body) > MAX_INGRESS_RESPONSE_BYTES:
        return None
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if status_code >= 400:
        detail = payload.get("detail")
        if not isinstance(detail, str) or len(detail) > 128:
            return None
        return {"detail": detail} if re.fullmatch(_SAFE_ERROR_PATTERN, detail) else None
    if (
        set(payload) != {"state", "photoId", "pendingAttachmentId"}
        or payload.get("state") not in {"uploaded", "consumed"}
        or (payload.get("photoId") is not None and not isinstance(payload.get("photoId"), str))
        or (payload.get("pendingAttachmentId") is not None and not isinstance(payload.get("pendingAttachmentId"), str))
    ):
        return None
    return payload


def create_app(*, client_factory: Callable[[], httpx.AsyncClient] = _new_upstream_client) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.router.redirect_slashes = False

    @app.get("/coffee-upload", include_in_schema=False)
    async def coffee_upload_page(request: Request) -> HTMLResponse:
        if request.query_params:
            return HTMLResponse("Not found", status_code=404, headers=_headers())
        return HTMLResponse(COFFEE_UPLOAD_PAGE, headers={**_headers(), "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"})

    @app.post("/api/v1/coffee-diary/photo-upload", include_in_schema=False)
    async def coffee_upload_photo(request: Request) -> Response:
        body = await _read_bounded_body(request)
        token = request.headers.get("X-Coffee-Upload-Token", "")
        headers = {
            "X-Coffee-Upload-Token": token,
            "Content-Type": request.headers.get("content-type", ""),
        }
        try:
            async with client_factory() as client:
                upstream = await client.post(COFFEE_UPLOAD_UPSTREAM_URL, content=body, headers=headers)
                upstream_body = await _read_bounded_upstream_body(upstream)
        except (httpx.HTTPError, OSError):
            return _error(503, "coffee_diary_upload_unavailable")

        if upstream_body is None:
            return _error(502, "coffee_diary_upload_unavailable")
        payload = _safe_upstream_payload(upstream.status_code, upstream_body)
        if payload is None:
            return _error(502, "coffee_diary_upload_unavailable")
        return JSONResponse(payload, status_code=upstream.status_code, headers=_headers())

    return app


app = create_app()


def configured_app() -> FastAPI:
    """Uvicorn factory used by production after validating all ingress config."""

    configured_coffee_upload_ingress()
    return app
