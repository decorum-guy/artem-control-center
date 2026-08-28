from __future__ import annotations

import hashlib
import io
import json
import zipfile
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

try:
    from PIL import Image
except ImportError:  # pragma: no cover - the image suite is enabled in CI/setup.
    Image = None  # type: ignore[assignment,misc]


def image_bytes(format_name: str = "JPEG", *, exif: bool = False) -> bytes:
    if Image is None:
        pytest.skip("Pillow is required for image normalization tests")
    image = Image.new("RGB", (32, 24), (146, 88, 38))
    output = io.BytesIO()
    kwargs = {"format": format_name}
    if exif:
        exif_data = image.getexif()
        exif_data[0x010E] = "Coffee test"
        kwargs["exif"] = exif_data.tobytes()
    image.save(output, **kwargs)
    return output.getvalue()


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
        client.post(f"/api/v1/coffee-diary/beans/{bean['id']}/extractions", headers={"Idempotency-Key": f"extract-{uuid4().hex}"}, json={"brewedAt": "2026-08-28T10:00:00Z", "doseGrams": 17.5, "extractionSeconds": 27, "yieldGrams": 36.0, "notes": "Строка, \"кавычки\"\r\nновая", "rating": None, "makeFavorite": True})
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
