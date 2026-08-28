from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from panel_agent.coffee_diary import (
    MAX_FILE_BYTES,
    CoffeeDiaryBeanCreate,
    CoffeeDiaryBeanPatch,
    CoffeeDiaryConflict,
    CoffeeDiaryExtractionCreate,
    CoffeeDiaryRecipe,
    CoffeeDiaryRecipeField,
    CoffeeDiaryStore,
    CoffeeDiaryStoreUnavailable,
    CoffeeDiaryValidationError,
)


def recipe(method: str = "Эспрессо", *, dose: int = 18) -> CoffeeDiaryRecipe:
    return CoffeeDiaryRecipe(
        method=method,
        fields=[CoffeeDiaryRecipeField(key="dose", label="Кофе", kind="number", value=dose, unit="г")],
    )


def bean_create(name: str = "Эфиопия") -> CoffeeDiaryBeanCreate:
    return CoffeeDiaryBeanCreate(name=name, roaster="Тестовая обжарка", defaultRecipe=recipe())


def extraction_create(snapshot: CoffeeDiaryRecipe | None = None, rating: int | None = None) -> CoffeeDiaryExtractionCreate:
    snapshot = snapshot or recipe()
    return CoffeeDiaryExtractionCreate(
        brewedAt="2026-08-28T10:00:00Z",
        method=snapshot.method,
        recipeSnapshot=snapshot,
        notes="Чистая чашка",
        rating=rating,
    )


def test_empty_store_is_valid_and_survives_reinstantiation(tmp_path):
    path = tmp_path / "coffee-diary.json"
    first = CoffeeDiaryStore(path, writes_enabled=True)
    assert first.read_document().model_dump(mode="json") == {
        "schemaVersion": "coffee.diary.v1", "revision": 0, "updatedAt": "1970-01-01T00:00:00Z",
        "beans": [], "extractions": [], "idempotency": [],
    }
    created = first.create_bean(bean_create(), "bean-key-0001")
    second = CoffeeDiaryStore(path, writes_enabled=True)
    assert second.read_document().beans[0].id == created.id


def test_bean_create_edit_stale_conflict_and_tombstone_preserve_history(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0002")
    edited = store.patch_bean(bean.id, CoffeeDiaryBeanPatch(name="Новое имя"), 1)
    assert edited.version == 2
    with pytest.raises(CoffeeDiaryConflict, match="revision_conflict"):
        store.patch_bean(bean.id, CoffeeDiaryBeanPatch(name="Старое имя"), 1)
    extraction = store.create_extraction(bean.id, extraction_create(), "extract-key-01")
    deleted = store.delete_bean(bean.id, 2)
    assert deleted.deletedAt is not None
    assert store.collection().beans == []
    assert store.read_document().extractions[0].id == extraction.id


def test_extraction_create_delete_snapshot_and_ratings(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0003")
    extraction = store.create_extraction(bean.id, extraction_create(rating=None), "extract-key-02")
    assert extraction.rating is None
    changed = store.patch_bean(bean.id, CoffeeDiaryBeanPatch(defaultRecipe=recipe("V60", dose=20)), 1)
    assert changed.defaultRecipe.method == "V60"
    assert store.read_document().extractions[0].recipeSnapshot.method == "Эспрессо"
    assert store.read_document().extractions[0].recipeSnapshot.fields[0].value == 18
    rated = store.create_extraction(bean.id, extraction_create(recipe("V60", dose=20), rating=10), "extract-key-03")
    assert rated.rating == 10
    deleted = store.delete_extraction(extraction.id, 1)
    assert deleted.deletedAt is not None
    assert len(store.collection().recentExtractions) == 1


@pytest.mark.parametrize("value", [0, 11, float("inf")])
def test_rating_bounds_are_fixed(value):
    with pytest.raises((ValidationError, ValueError)):
        extraction_create(rating=value)


def test_recipe_is_flexible_but_strict_and_bounded():
    assert CoffeeDiaryRecipe(method="Aeropress", fields=[]).method == "Aeropress"
    with pytest.raises(ValidationError):
        CoffeeDiaryRecipeField(key="dose", label="Кофе", kind="number", value="18", unit="г")
    with pytest.raises(ValidationError):
        CoffeeDiaryRecipe(method="V60", fields=[CoffeeDiaryRecipeField(key="dose", label="Кофе", kind="number", value=1, unit="г")] * 25)
    with pytest.raises(ValidationError):
        CoffeeDiaryRecipe(method="V60", fields=[CoffeeDiaryRecipeField(key="dose", label="<script>", kind="number", value=1, unit="г")])
    with pytest.raises(ValidationError):
        CoffeeDiaryBeanCreate(name="x" * 97)


def test_same_idempotency_key_replays_and_different_body_conflicts(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    first = store.create_bean(bean_create("Один"), "bean-key-0004")
    replay = store.create_bean(bean_create("Один"), "bean-key-0004")
    assert replay.id == first.id
    assert store.read_document().revision == 1
    with pytest.raises(CoffeeDiaryConflict, match="idempotency_key_reused"):
        store.create_bean(bean_create("Другой"), "bean-key-0004")


@pytest.mark.parametrize("raw", [b"{not-json", json.dumps({"schemaVersion": "coffee.diary.v0"}).encode(), b"x" * (MAX_FILE_BYTES + 1)])
def test_corrupt_unsupported_oversized_store_fails_closed_and_is_not_overwritten(tmp_path, raw):
    path = tmp_path / "coffee.json"
    path.write_bytes(raw)
    before = path.read_bytes()
    store = CoffeeDiaryStore(path, writes_enabled=True)
    with pytest.raises(CoffeeDiaryStoreUnavailable):
        store.read_document()
    with pytest.raises(CoffeeDiaryStoreUnavailable):
        store.create_bean(bean_create(), "bean-key-0005")
    assert path.read_bytes() == before


def test_atomic_write_failure_preserves_previous_document(tmp_path, monkeypatch):
    path = tmp_path / "coffee.json"
    store = CoffeeDiaryStore(path, writes_enabled=True)
    store.create_bean(bean_create(), "bean-key-0006")
    before = path.read_bytes()
    monkeypatch.setattr("panel_agent.coffee_diary.os.replace", lambda *_: (_ for _ in ()).throw(OSError("disk")))
    with pytest.raises(CoffeeDiaryStoreUnavailable, match="coffee_diary_store_write_failed"):
        store.create_bean(bean_create("Не записалось"), "bean-key-0007")
    assert path.read_bytes() == before


def test_export_is_complete_but_has_no_ledger_paths_or_secrets(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0008")
    store.create_extraction(bean.id, extraction_create(), "extract-key-04")
    exported = store.export().model_dump(mode="json")
    assert exported["schemaVersion"] == "coffee.diary.export.v1"
    assert len(exported["beans"]) == 1 and len(exported["extractions"]) == 1
    encoded = json.dumps(exported, ensure_ascii=False)
    for forbidden in ("PANEL_COFFEE_DIARY_PATH", "coffee-diary.json", "token", "session"):
        assert forbidden not in encoded.lower()


def _api_module(monkeypatch, tmp_path):
    monkeypatch.setenv("PANEL_AGENT_MODE", "integration_test")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_COFFEE_DIARY_PATH", str(tmp_path / "api-coffee.json"))
    import panel_agent.main as module
    return importlib.reload(module)


def test_api_uses_fixed_routes_headers_and_rejects_unknown_shape(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        recipe_payload = {"method": "Эспрессо", "fields": [{"key": "dose", "label": "Кофе", "kind": "number", "value": 18, "unit": "г"}]}
        payload = {"name": "API кофе", "defaultRecipe": recipe_payload}
        missing_key = client.post("/api/v1/coffee-diary/beans", json=payload)
        assert missing_key.status_code == 428
        created = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": "api-bean-0001"}, json=payload)
        assert created.status_code == 201
        bean = created.json()
        assert created.headers["etag"] == '"1"'
        unknown = client.patch(f"/api/v1/coffee-diary/beans/{bean['id']}", headers={"If-Match": '"1"'}, json={"path": "/tmp/other"})
        assert unknown.status_code == 422
        missing_match = client.patch(f"/api/v1/coffee-diary/beans/{bean['id']}", json={"name": "x"})
        assert missing_match.status_code == 428
        stale = client.patch(f"/api/v1/coffee-diary/beans/{bean['id']}", headers={"If-Match": '"1"'}, json={"name": "x"})
        assert stale.status_code == 200
        conflict = client.patch(f"/api/v1/coffee-diary/beans/{bean['id']}", headers={"If-Match": '"1"'}, json={"name": "y"})
        assert conflict.status_code == 409
        extraction_payload = {
            "brewedAt": "2026-08-28T10:00:00Z",
            "method": "Эспрессо",
            "recipeSnapshot": recipe_payload,
            "notes": None,
            "rating": None,
        }
        extraction = client.post(
            f"/api/v1/coffee-diary/beans/{bean['id']}/extractions",
            headers={"Idempotency-Key": "api-extract-01"},
            json=extraction_payload,
        )
        assert extraction.status_code == 201
        assert extraction.headers["etag"] == '"1"'
        missing_extraction_match = client.delete(f"/api/v1/coffee-diary/extractions/{extraction.json()['id']}")
        assert missing_extraction_match.status_code == 428
        deleted_extraction = client.delete(
            f"/api/v1/coffee-diary/extractions/{extraction.json()['id']}",
            headers={"If-Match": '"1"'},
        )
        assert deleted_extraction.status_code == 200
        assert deleted_extraction.headers["etag"] == '"2"'
        missing_bean_match = client.delete(f"/api/v1/coffee-diary/beans/{bean['id']}")
        assert missing_bean_match.status_code == 428
        deleted_bean = client.delete(f"/api/v1/coffee-diary/beans/{bean['id']}", headers={"If-Match": '"2"'})
        assert deleted_bean.status_code == 200
        assert client.get("/api/v1/coffee-diary/beans/not-a-uuid").status_code == 422
        exported = client.get("/api/v1/coffee-diary/export")
        assert exported.status_code == 200
        assert exported.headers["content-type"].startswith("application/json")
        assert exported.json()["schemaVersion"] == "coffee.diary.export.v1"
        assert not any(getattr(route, "path", "").endswith("/{path}") for route in module.app.routes)
