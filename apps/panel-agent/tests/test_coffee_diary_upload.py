from __future__ import annotations

import hashlib
import io
import json
import re
import struct
import zipfile
import zlib
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest
from PIL import Image, ImageOps
from PIL.TiffImagePlugin import IFDRational
from fastapi.testclient import TestClient


def image_bytes(
    format_name: str = "JPEG",
    *,
    exif: bool = False,
    size: tuple[int, int] = (32, 24),
    orientation: int | None = None,
    gps: bool = False,
) -> bytes:
    image = Image.new("RGB", size, (146, 88, 38))
    output = io.BytesIO()
    kwargs = {"format": format_name}
    if exif or orientation is not None or gps:
        exif_data = image.getexif()
        if exif:
            exif_data[0x010E] = "Coffee test"
        if orientation is not None:
            exif_data[0x0112] = orientation
        if gps:
            gps_data = exif_data.get_ifd(0x8825)
            gps_data[0x0001] = "N"
            gps_data[0x0002] = tuple(IFDRational(value, 1) for value in (55, 45, 0))
            gps_data[0x0003] = "E"
            gps_data[0x0004] = tuple(IFDRational(value, 1) for value in (37, 36, 0))
        kwargs["exif"] = exif_data.tobytes()
    image.save(output, **kwargs)
    return output.getvalue()


def _png_with_dimensions(width: int, height: int) -> bytes:
    """Create a tiny PNG whose trusted IHDR dimensions exercise bounds."""
    payload = bytearray(image_bytes("PNG"))
    struct.pack_into(">II", payload, 16, width, height)
    struct.pack_into(">I", payload, 29, zlib.crc32(payload[12:29]) & 0xFFFFFFFF)
    return bytes(payload)


def _api_module(monkeypatch, tmp_path):
    monkeypatch.setenv("PANEL_AGENT_MODE", "integration_test")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_COFFEE_DIARY_PATH", str(tmp_path / "coffee.json"))
    monkeypatch.setenv("PANEL_COFFEE_DIARY_IMAGE_DIR", str(tmp_path / "images"))
    import importlib
    import panel_agent.main as module
    return importlib.reload(module)


def api_bean(name: str = "Фото кофе"):
    return {"name": name, "grindDescription": "Средний", "preferredDrink": "espresso", "notes": "Тест"}


def create_bean(client: TestClient, name: str = "Фото кофе"):
    response = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": f"bean-{uuid4().hex}"}, json=api_bean(name))
    assert response.status_code == 201
    return response.json()


def upload_existing_photo(client: TestClient, bean_id: str, payload: bytes, media_type: str):
    session_response = client.post(f"/api/v1/coffee-diary/beans/{bean_id}/photo-upload-sessions")
    assert session_response.status_code == 200
    token = session_response.json()["uploadUrl"].split("#token=", 1)[1]
    return client.post(
        "/api/v1/coffee-diary/photo-upload",
        headers={"X-Coffee-Upload-Token": token, "Content-Type": media_type},
        content=payload,
    )


def test_registry_enforces_expiry_and_cancel_without_plaintext_tokens(tmp_path):
    from panel_agent.coffee_diary import CoffeeDiaryValidationError
    from panel_agent.coffee_diary_upload import (
        STAGED_ATTACHMENT_GRACE_SECONDS,
        UPLOAD_SESSION_TTL_SECONDS,
        NormalizedImage,
        PhotoStorage,
        PhotoUploadRegistry,
    )

    monotonic_now = [10.0]
    wall_now = [datetime(2026, 8, 28, 10, 0, tzinfo=timezone.utc)]
    registry = PhotoUploadRegistry(
        PhotoStorage(tmp_path / "images"),
        monotonic=lambda: monotonic_now[0],
        wall_clock=lambda: wall_now[0],
    )
    _, token = registry.create(intent="bean_create", bean_id=None)
    assert all(token not in session.__dict__.values() for session in registry.sessions.values())
    monotonic_now[0] += UPLOAD_SESSION_TTL_SECONDS + 1
    with pytest.raises(CoffeeDiaryValidationError, match="coffee_diary_upload_token_expired"):
        registry.begin_upload(token)

    session, cancelled_token = registry.create(intent="bean_create", bean_id=None)
    assert registry.cancel(session.session_id)["state"] == "cancelled"
    with pytest.raises(CoffeeDiaryValidationError, match="coffee_diary_upload_token_cancelled"):
        registry.begin_upload(cancelled_token)

    staged_session, staged_token = registry.create(intent="bean_create", bean_id=None)
    registry.begin_upload(staged_token)
    normalized = PhotoStorage(tmp_path / "images").new_temp_file(prefix="normalized-")
    normalized.write_bytes(b"normalized")
    pending_id, staged_path = registry.finish_staged(
        staged_session.session_id,
        NormalizedImage(normalized, "image/jpeg", 10, 2, 2, hashlib.sha256(b"normalized").hexdigest()),
    )
    assert staged_path.is_file()
    monotonic_now[0] += STAGED_ATTACHMENT_GRACE_SECONDS + 1
    assert registry.status(staged_session.session_id)["state"] == "expired"
    assert not staged_path.exists()
    assert pending_id not in registry._staged


@pytest.mark.parametrize(
    ("format_name", "media_type"),
    [("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")],
)
def test_required_image_formats_are_decoded_normalized_and_persisted(
    monkeypatch, tmp_path, format_name, media_type,
):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        bean = create_bean(client, f"Формат {format_name}")
        response = upload_existing_photo(client, bean["id"], image_bytes(format_name), media_type)
        assert response.status_code == 200
        photo_id = response.json()["photoId"]

        photo = next(item for item in client.get("/api/v1/coffee-diary").json()["photos"] if item["id"] == photo_id)
        content = client.get(f"/api/v1/coffee-diary/photos/{photo_id}/content")
        assert content.status_code == 200
        assert photo["mediaType"] == "image/jpeg"
        assert photo["byteSize"] == len(content.content)
        assert photo["sha256"] == hashlib.sha256(content.content).hexdigest()
        assert photo["width"] == 32 and photo["height"] == 24
        assert re.fullmatch(r"[0-9a-f]{32}\.jpg", photo["storageId"])
        assert str(tmp_path) not in json.dumps(photo)
        assert content.headers["etag"] == f'"{photo["sha256"]}"'
        assert content.headers["x-content-type-options"] == "nosniff"
        with Image.open(io.BytesIO(content.content)) as normalized:
            assert normalized.format == "JPEG"
            assert normalized.size == (32, 24)


@pytest.mark.parametrize(
    ("payload", "media_type", "detail"),
    [
        (b"plain text", "image/jpeg", "coffee_diary_upload_image_invalid"),
        (b"\xff\xd8\xff\xd9", "image/jpeg", "coffee_diary_upload_image_invalid"),
        (b"MZ\x90\x00not-an-image", "image/jpeg", "coffee_diary_upload_image_invalid"),
        (image_bytes("JPEG"), "image/png", "coffee_diary_upload_media_type_invalid"),
    ],
)
def test_non_images_malformed_images_and_mime_mismatches_are_rejected(
    monkeypatch, tmp_path, payload, media_type, detail,
):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        bean = create_bean(client, "Невалидная фотография")
        response = upload_existing_photo(client, bean["id"], payload, media_type)
        assert response.status_code == 422
        assert response.json()["detail"] == detail
        assert client.get("/api/v1/coffee-diary").json()["photos"] == []


def test_upload_byte_and_pixel_bounds_and_decompression_bomb_handling(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    from panel_agent.coffee_diary_upload import MAX_IMAGE_SIDE

    with TestClient(module.app) as client:
        bean = create_bean(client, "Ограничения изображения")

        too_large = upload_existing_photo(
            client, bean["id"], b"x" * (module.MAX_UPLOAD_BYTES + 1), "image/jpeg",
        )
        assert too_large.status_code == 413
        assert too_large.json()["detail"] == "coffee_diary_upload_file_too_large"

        too_wide = upload_existing_photo(
            client, bean["id"], _png_with_dimensions(MAX_IMAGE_SIDE + 1, 1), "image/png",
        )
        assert too_wide.status_code == 422
        assert too_wide.json()["detail"] == "coffee_diary_upload_dimensions_invalid"

        too_many_pixels = upload_existing_photo(
            client, bean["id"], _png_with_dimensions(8_000, 7_501), "image/png",
        )
        assert too_many_pixels.status_code == 422
        assert too_many_pixels.json()["detail"] == "coffee_diary_upload_dimensions_invalid"

        monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1)
        bomb = upload_existing_photo(client, bean["id"], image_bytes("JPEG"), "image/jpeg")
        assert bomb.status_code == 422
        assert bomb.json()["detail"] == "coffee_diary_upload_dimensions_invalid"
        assert client.get("/api/v1/coffee-diary").json()["photos"] == []


def test_exif_gps_and_orientation_are_removed_while_dimensions_and_hash_are_canonical(
    monkeypatch, tmp_path,
):
    module = _api_module(monkeypatch, tmp_path)
    source = Image.new("RGB", (40, 20), (24, 24, 24))
    for y in range(10):
        for x in range(10):
            source.putpixel((x, y), (255, 0, 0))
    for y in range(10, 20):
        for x in range(30, 40):
            source.putpixel((x, y), (0, 0, 255))
    exif = source.getexif()
    exif[0x0112] = 6
    exif[0x010E] = "Coffee source metadata"
    gps = exif.get_ifd(0x8825)
    gps[0x0001] = "N"
    gps[0x0002] = tuple(IFDRational(value, 1) for value in (55, 45, 0))
    gps[0x0003] = "E"
    gps[0x0004] = tuple(IFDRational(value, 1) for value in (37, 36, 0))
    source_bytes = io.BytesIO()
    source.save(source_bytes, format="JPEG", exif=exif.tobytes())

    with TestClient(module.app) as client:
        bean = create_bean(client, "EXIF и ориентация")
        response = upload_existing_photo(client, bean["id"], source_bytes.getvalue(), "image/jpeg")
        assert response.status_code == 200
        photo_id = response.json()["photoId"]
        content = client.get(f"/api/v1/coffee-diary/photos/{photo_id}/content")
        photo = next(item for item in client.get("/api/v1/coffee-diary").json()["photos"] if item["id"] == photo_id)
        expected = ImageOps.exif_transpose(source).convert("RGB")
        assert photo["width"] == 20 and photo["height"] == 40
        assert photo["byteSize"] == len(content.content)
        assert photo["sha256"] == hashlib.sha256(content.content).hexdigest()
        with Image.open(io.BytesIO(content.content)) as normalized:
            assert normalized.size == (20, 40)
            assert normalized.getpixel((15, 5))[0] > 150
            assert normalized.getpixel((5, 35))[2] > 120
            assert normalized.getpixel((15, 5)) == pytest.approx(expected.getpixel((15, 5)), abs=35)
            assert normalized.getpixel((5, 35)) == pytest.approx(expected.getpixel((5, 35)), abs=35)
            assert normalized.getpixel((5, 5))[0] < 100
            assert normalized.getpixel((15, 35))[2] < 100
            assert normalized.getexif() == {}
            assert normalized.getexif().get_ifd(0x8825) == {}


def test_upload_token_is_hashed_opaque_one_time_and_bound_to_existing_bean(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        bean = create_bean(client, "A")
        other_bean = create_bean(client, "B")
        created = client.post(f"/api/v1/coffee-diary/beans/{bean['id']}/photo-upload-sessions")
        assert created.status_code == 200
        session = created.json()
        token = session["uploadUrl"].split("#token=", 1)[1]
        assert len(token) >= 43
        assert "?token=" not in session["uploadUrl"]
        assert all(not hasattr(item, "token") for item in module.coffee_upload_registry.sessions.values())
        assert all(token not in item.__dict__.values() for item in module.coffee_upload_registry.sessions.values())

        uploaded = client.post(f"/api/v1/coffee-diary/photo-upload?beanId={other_bean['id']}&storageId=outside", headers={"X-Coffee-Upload-Token": token, "Content-Type": "image/jpeg"}, content=image_bytes())
        assert uploaded.status_code == 200
        photo_id = uploaded.json()["photoId"]
        replay = client.post("/api/v1/coffee-diary/photo-upload", headers={"X-Coffee-Upload-Token": token, "Content-Type": "image/jpeg"}, content=image_bytes())
        assert replay.status_code == 409
        assert replay.json()["detail"] == "coffee_diary_upload_token_consumed"

        collection = client.get("/api/v1/coffee-diary").json()
        assert collection["beans"][0]["photoIds"] == [photo_id]
        assert collection["beans"][1]["photoIds"] == []
        photo = collection["photos"][0]
        assert photo["sha256"] == hashlib.sha256(client.get(f"/api/v1/coffee-diary/photos/{photo_id}/content").content).hexdigest()
        content = client.get(f"/api/v1/coffee-diary/photos/{photo_id}/content")
        assert content.status_code == 200
        assert content.headers["etag"] == '"' + photo["sha256"] + '"'
        assert content.headers["x-content-type-options"] == "nosniff"

        reloaded_module = _api_module(monkeypatch, tmp_path)
        with TestClient(reloaded_module.app) as reloaded_client:
            persisted = reloaded_client.get(f"/api/v1/coffee-diary/photos/{photo_id}/content")
            assert persisted.status_code == 200
            assert hashlib.sha256(persisted.content).hexdigest() == photo["sha256"]

        invalid = client.post("/api/v1/coffee-diary/photo-upload", headers={"X-Coffee-Upload-Token": "not-a-token"}, content=b"bad")
        assert invalid.status_code == 403


def test_invalid_image_retry_budget_and_staged_new_bean_idempotent_claim(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        staged = client.post("/api/v1/coffee-diary/photo-upload-sessions", json={"intent": "bean_create"}).json()
        token = staged["uploadUrl"].split("#token=", 1)[1]
        invalid = client.post("/api/v1/coffee-diary/photo-upload", headers={"X-Coffee-Upload-Token": token, "Content-Type": "image/jpeg"}, content=b"plain text")
        assert invalid.status_code == 422
        assert invalid.json()["detail"] == "coffee_diary_upload_image_invalid"
        assert client.get(f"/api/v1/coffee-diary/photo-upload-sessions/{staged['sessionId']}").json()["state"] == "created"
        for _ in range(4):
            retry = client.post("/api/v1/coffee-diary/photo-upload", headers={"X-Coffee-Upload-Token": token, "Content-Type": "image/jpeg"}, content=b"still invalid")
        assert retry.status_code == 422
        expired = client.post("/api/v1/coffee-diary/photo-upload", headers={"X-Coffee-Upload-Token": token, "Content-Type": "image/jpeg"}, content=image_bytes())
        assert expired.status_code == 410
        assert expired.json()["detail"] == "coffee_diary_upload_token_expired"

        staged = client.post("/api/v1/coffee-diary/photo-upload-sessions", json={"intent": "bean_create"}).json()
        token = staged["uploadUrl"].split("#token=", 1)[1]
        accepted = client.post("/api/v1/coffee-diary/photo-upload", headers={"X-Coffee-Upload-Token": token, "Content-Type": "image/jpeg"}, content=image_bytes("JPEG", exif=True))
        assert accepted.status_code == 200
        pending_id = accepted.json()["pendingAttachmentId"]
        preview = client.get(f"/api/v1/coffee-diary/pending-photo-attachments/{pending_id}/content")
        assert preview.status_code == 200

        body = {**api_bean("Эфиопия"), "pendingPhotoAttachmentIds": [pending_id]}
        key = f"bean-{uuid4().hex}"
        first = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": key}, json=body)
        replay = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": key}, json=body)
        assert first.status_code == replay.status_code == 201
        assert first.json()["id"] == replay.json()["id"]
        assert first.json()["photoIds"]
        document = module.coffee_diary_store.read_document().model_dump(mode="json")
        photo = next(item for item in document["photos"] if item["id"] == first.json()["photoIds"][0])
        assert photo["beanId"] == first.json()["id"]
        assert len(document["photos"]) == 1


def test_missing_canonical_photo_file_fails_truthfully_without_deleting_metadata(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    from panel_agent.coffee_diary import CoffeeDiaryPhoto

    with TestClient(module.app) as client:
        bean = create_bean(client, "Файл отсутствует")
        photo = CoffeeDiaryPhoto(
            id=uuid4(),
            beanId=UUID(bean["id"]),
            storageId="missing.jpg",
            mediaType="image/jpeg",
            byteSize=12,
            width=2,
            height=2,
            sha256="a" * 64,
            createdAt="2026-08-28T10:00:00Z",
        )
        module.coffee_diary_store.attach_photo(UUID(bean["id"]), photo)
        content = client.get(f"/api/v1/coffee-diary/photos/{photo.id}/content")
        assert content.status_code == 404
        assert content.json()["detail"] == "coffee_diary_photo_file_missing"
        archive = client.get("/api/v1/coffee-diary/export.zip")
        assert archive.status_code == 503
        assert archive.json()["detail"] == "coffee_diary_photo_file_missing"
        assert any(candidate["id"] == str(photo.id) for candidate in client.get("/api/v1/coffee-diary/export").json()["photos"])


def test_csv_and_zip_exports_are_safe_and_resolvable(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        bean = create_bean(client, "=Безопасный, кофе")
        extraction = client.post(f"/api/v1/coffee-diary/beans/{bean['id']}/extractions", headers={"Idempotency-Key": f"extract-{uuid4().hex}"}, json={"brewedAt": "2026-08-28T10:00:00Z", "doseGrams": 17.5, "extractionSeconds": 27, "yieldGrams": 36.0, "notes": "Строка, \"кавычки\"", "rating": None, "makeFavorite": True})
        assert extraction.status_code == 201
        session = client.post(f"/api/v1/coffee-diary/beans/{bean['id']}/photo-upload-sessions").json()
        token = session["uploadUrl"].split("#token=", 1)[1]
        client.post("/api/v1/coffee-diary/photo-upload", headers={"X-Coffee-Upload-Token": token, "Content-Type": "image/jpeg"}, content=image_bytes())

        csv_response = client.get("/api/v1/coffee-diary/export.csv")
        assert csv_response.status_code == 200
        assert csv_response.content.startswith(b"\xef\xbb\xbfcoffee_id,coffee_name")
        assert "'=Безопасный, кофе".encode("utf-8") in csv_response.content  # Prefix keeps a spreadsheet from executing the cell.
        assert b"17.5" in csv_response.content and b"36.0" in csv_response.content

        archive_response = client.get("/api/v1/coffee-diary/export.zip")
        assert archive_response.status_code == 200
        with zipfile.ZipFile(io.BytesIO(archive_response.content)) as archive:
            names = archive.namelist()
            assert "coffee-diary.json" in names
            assert "coffee-diary-extractions.csv" in names
            assert "manifest.json" in names
            manifest = json.loads(archive.read("manifest.json"))
            for entry in manifest["images"]:
                assert entry["path"] in names
                assert hashlib.sha256(archive.read(entry["path"])).hexdigest() == entry["sha256"]
                assert ".." not in entry["path"] and not entry["path"].startswith("/")
            assert not any(secret in archive_response.content for secret in (b"X-Coffee-Upload-Token", b"PANEL_COFFEE_DIARY_IMAGE_DIR"))
