from __future__ import annotations

import importlib
import json
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from panel_agent.coffee_diary import (
    MAX_FILE_BYTES,
    CoffeeDiaryBeanCreate,
    CoffeeDiaryBeanPatch,
    CoffeeDiaryConflict,
    CoffeeDiaryDocument,
    CoffeeDiaryExtractionCreate,
    CoffeeDiaryNotFound,
    CoffeeDiaryPhoto,
    CoffeeDiaryStore,
    CoffeeDiaryStoreUnavailable,
    CoffeeDiaryValidationError,
)


def bean_create(
    name: str = "Эфиопия",
    *,
    grind: str | None = "Чуть мельче среднего",
    preferred: str | None = "espresso",
    notes: str | None = "Шоколад и ягоды",
) -> CoffeeDiaryBeanCreate:
    return CoffeeDiaryBeanCreate(
        name=name,
        grindDescription=grind,
        preferredDrink=preferred,
        notes=notes,
        roaster="Тестовая обжарка",
    )


def extraction_create(
    *,
    dose: int | float = 17.5,
    seconds: int = 27,
    yield_grams: int | float = 36.0,
    notes: str | None = "Сладко, хороший баланс",
    rating: int | None = None,
    make_favorite: bool = False,
) -> CoffeeDiaryExtractionCreate:
    return CoffeeDiaryExtractionCreate(
        brewedAt="2026-08-28T10:00:00Z",
        doseGrams=dose,
        extractionSeconds=seconds,
        yieldGrams=yield_grams,
        notes=notes,
        rating=rating,
        makeFavorite=make_favorite,
    )


def test_empty_store_is_valid_and_survives_reinstantiation(tmp_path):
    path = tmp_path / "coffee-diary.json"
    first = CoffeeDiaryStore(path, writes_enabled=True)
    assert first.read_document().model_dump(mode="json") == {
        "schemaVersion": "coffee.diary.v1", "revision": 0, "updatedAt": "1970-01-01T00:00:00Z",
        "beans": [], "extractions": [], "photos": [], "idempotency": [],
    }
    created = first.create_bean(bean_create(), "bean-key-0001")
    second = CoffeeDiaryStore(path, writes_enabled=True)
    assert second.read_document().beans[0].id == created.id


def test_bean_core_fields_and_same_name_records_are_independent(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    first = store.create_bean(bean_create(), "bean-key-0002")
    second = store.create_bean(bean_create(grind="Грубее", preferred="milk"), "bean-key-0003")
    assert first.id != second.id
    assert first.name == second.name == "Эфиопия"
    assert first.grindDescription == "Чуть мельче среднего"
    assert first.preferredDrink == "espresso"
    assert second.preferredDrink == "milk"
    assert first.favoriteExtractionId is None and first.photoIds == []
    assert {bean.id for bean in store.collection().beans} == {first.id, second.id}


@pytest.mark.parametrize("preferred", ["espresso", "milk", "universal", None])
def test_preferred_drink_values_are_explicit(preferred):
    assert bean_create(preferred=preferred).preferredDrink == preferred


def test_invalid_preferred_drink_is_rejected():
    with pytest.raises(ValidationError, match="coffee_diary_preferred_drink_invalid"):
        bean_create(preferred="filter")


@pytest.mark.parametrize("value", [17, 17.0, 17.1, 17.5])
def test_dose_grams_accepts_tenths(value):
    assert extraction_create(dose=value).doseGrams == value


@pytest.mark.parametrize("value", [36, 36.0, 36.1])
def test_yield_grams_accepts_tenths(value):
    assert extraction_create(yield_grams=value).yieldGrams == value


@pytest.mark.parametrize("field", ["dose", "yield_grams"])
@pytest.mark.parametrize("value", [17.15, 17.123, 0, -1, float("nan"), float("inf"), 1_001])
def test_grams_reject_unsupported_precision_and_invalid_physical_values(field, value):
    kwargs = {field: value}
    with pytest.raises((ValidationError, ValueError)) as error:
        extraction_create(**kwargs)
    if value == 17.15:
        assert "coffee_diary_grams_precision_invalid" in str(error.value)


def test_extraction_shot_fields_persist_and_support_multiple_attempts(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0004")
    first = store.create_extraction(bean.id, extraction_create(), "extract-key-0001")
    second = store.create_extraction(bean.id, extraction_create(dose=18.0, seconds=30, yield_grams=38.0), "extract-key-0002")
    assert first.doseGrams == 17.5 and first.extractionSeconds == 27 and first.yieldGrams == 36.0
    assert second.doseGrams == 18.0 and second.extractionSeconds == 30 and second.yieldGrams == 38.0
    assert len(store.bean_detail(bean.id).extractions) == 2


def test_favorite_can_change_clear_and_never_cross_beans(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0005")
    other = store.create_bean(bean_create("Другая чашка"), "bean-key-0006")
    first = store.create_extraction(bean.id, extraction_create(), "extract-key-0003")
    second = store.create_extraction(bean.id, extraction_create(dose=18), "extract-key-0004")
    foreign = store.create_extraction(other.id, extraction_create(), "extract-key-0005")

    selected = store.set_favorite_extraction(bean.id, first.id, 1)
    assert selected.favoriteExtractionId == first.id and selected.version == 2
    selected = store.set_favorite_extraction(bean.id, second.id, 2)
    assert selected.favoriteExtractionId == second.id and selected.version == 3
    assert len(store.bean_detail(bean.id).extractions) == 2
    with pytest.raises(CoffeeDiaryValidationError, match="coffee_diary_extraction_belongs_to_another_bean"):
        store.set_favorite_extraction(bean.id, foreign.id, 3)
    cleared = store.set_favorite_extraction(bean.id, None, 3)
    assert cleared.favoriteExtractionId is None and cleared.version == 4


def test_create_make_favorite_is_atomic_and_replay_does_not_reapply_stale_side_effect(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0007")
    first = store.create_extraction(bean.id, extraction_create(make_favorite=True), "extract-key-0006")
    after_first = store.bean_detail(bean.id).bean
    assert after_first.favoriteExtractionId == first.id and after_first.version == 2

    second = store.create_extraction(bean.id, extraction_create(dose=18, make_favorite=False), "extract-key-0007")
    changed = store.set_favorite_extraction(bean.id, second.id, 2)
    assert changed.favoriteExtractionId == second.id and changed.version == 3

    replay = store.create_extraction(bean.id, extraction_create(make_favorite=True), "extract-key-0006")
    current = store.bean_detail(bean.id).bean
    assert replay.id == first.id
    assert current.favoriteExtractionId == second.id
    assert len(store.read_document().extractions) == 2


def test_deleting_current_favorite_tombstones_only_it_and_clears_relationship(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0008")
    first = store.create_extraction(bean.id, extraction_create(make_favorite=True), "extract-key-0008")
    second = store.create_extraction(bean.id, extraction_create(dose=18), "extract-key-0009")
    deleted = store.delete_extraction(first.id, 1)
    current = store.bean_detail(bean.id).bean
    assert deleted.deletedAt is not None
    assert current.favoriteExtractionId is None and current.version == 3
    assert [item.id for item in store.bean_detail(bean.id).extractions] == [second.id]


def test_deleted_extraction_cannot_become_favorite(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0009")
    extraction = store.create_extraction(bean.id, extraction_create(), "extract-key-0010")
    store.delete_extraction(extraction.id, 1)
    with pytest.raises(CoffeeDiaryNotFound, match="coffee_diary_extraction_not_found"):
        store.set_favorite_extraction(bean.id, extraction.id, 1)


def test_same_idempotency_key_replays_and_different_body_conflicts(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    first = store.create_bean(bean_create("Один"), "bean-key-0010")
    replay = store.create_bean(bean_create("Один"), "bean-key-0010")
    assert replay.id == first.id
    assert store.read_document().revision == 1
    with pytest.raises(CoffeeDiaryConflict, match="coffee_diary_idempotency_key_reused"):
        store.create_bean(bean_create("Другой"), "bean-key-0010")


def test_extraction_idempotency_is_bound_to_bean_payload_and_make_favorite(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean_a = store.create_bean(bean_create("А"), "bean-key-0011")
    bean_b = store.create_bean(bean_create("Б"), "bean-key-0012")
    first = store.create_extraction(bean_a.id, extraction_create(), "extract-key-0011")
    replay = store.create_extraction(bean_a.id, extraction_create(), "extract-key-0011")
    assert replay.id == first.id
    with pytest.raises(CoffeeDiaryConflict, match="coffee_diary_idempotency_key_reused"):
        store.create_extraction(bean_b.id, extraction_create(), "extract-key-0011")
    with pytest.raises(CoffeeDiaryConflict, match="coffee_diary_idempotency_key_reused"):
        store.create_extraction(bean_a.id, extraction_create(dose=18), "extract-key-0011")
    with pytest.raises(CoffeeDiaryConflict, match="coffee_diary_idempotency_key_reused"):
        store.create_extraction(bean_a.id, extraction_create(make_favorite=True), "extract-key-0011")
    assert len(store.read_document().extractions) == 1


def test_photo_relationship_envelope_is_strict_and_empty_by_default(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0013")
    exported = store.export().model_dump(mode="json")
    assert bean.photoIds == [] and exported["photos"] == []
    assert exported["beans"][0]["favoriteExtractionId"] is None

    photo_id = UUID("11111111-1111-4111-8111-111111111111")
    photo = CoffeeDiaryPhoto(
        id=photo_id,
        beanId=bean.id,
        storageId="photo-1",
        mediaType="image/jpeg",
        byteSize=100,
        width=10,
        height=10,
        sha256="a" * 64,
        createdAt="2026-08-28T10:00:00Z",
    )
    document = CoffeeDiaryDocument(
        schemaVersion="coffee.diary.v1", revision=1, updatedAt="2026-08-28T10:00:00Z",
        beans=[bean.model_copy(update={"photoIds": [photo_id]})], photos=[photo],
    )
    assert document.photos[0].storageId == "photo-1"
    with pytest.raises(ValidationError):
        CoffeeDiaryPhoto(
            id=photo.id, beanId=bean.id, storageId="/absolute/path", mediaType="image/jpeg",
            byteSize=100, width=10, height=10, sha256="a" * 64, createdAt="2026-08-28T10:00:00Z",
        )


@pytest.mark.parametrize("raw", [b"{not-json", json.dumps({"schemaVersion": "coffee.diary.v0"}).encode(), b"x" * (MAX_FILE_BYTES + 1)])
def test_corrupt_unsupported_oversized_store_fails_closed_and_is_not_overwritten(tmp_path, raw):
    path = tmp_path / "coffee.json"
    path.write_bytes(raw)
    before = path.read_bytes()
    store = CoffeeDiaryStore(path, writes_enabled=True)
    with pytest.raises(CoffeeDiaryStoreUnavailable):
        store.read_document()
    with pytest.raises(CoffeeDiaryStoreUnavailable):
        store.create_bean(bean_create(), "bean-key-0014")
    assert path.read_bytes() == before


def test_atomic_write_failure_preserves_previous_document(tmp_path, monkeypatch):
    path = tmp_path / "coffee.json"
    store = CoffeeDiaryStore(path, writes_enabled=True)
    store.create_bean(bean_create(), "bean-key-0015")
    before = path.read_bytes()
    monkeypatch.setattr("panel_agent.coffee_diary.os.replace", lambda *_: (_ for _ in ()).throw(OSError("disk")))
    with pytest.raises(CoffeeDiaryStoreUnavailable, match="coffee_diary_store_write_failed"):
        store.create_bean(bean_create("Не записалось"), "bean-key-0016")
    assert path.read_bytes() == before


def test_export_has_relationships_but_no_ledger_paths_or_secrets(tmp_path):
    store = CoffeeDiaryStore(tmp_path / "coffee.json", writes_enabled=True)
    bean = store.create_bean(bean_create(), "bean-key-0017")
    extraction = store.create_extraction(bean.id, extraction_create(make_favorite=True), "extract-key-0017")
    exported = store.export().model_dump(mode="json")
    assert exported["schemaVersion"] == "coffee.diary.export.v1"
    assert exported["beans"][0]["favoriteExtractionId"] == str(extraction.id)
    assert exported["photos"] == []
    encoded = json.dumps(exported, ensure_ascii=False)
    for forbidden in ("PANEL_COFFEE_DIARY_PATH", "coffee-diary.json", "token", "session", "idempotency"):
        assert forbidden not in encoded.lower()


def _api_module(monkeypatch, tmp_path):
    monkeypatch.setenv("PANEL_AGENT_MODE", "integration_test")
    monkeypatch.setenv("PANEL_WRITES_ENABLED", "true")
    monkeypatch.setenv("PANEL_COFFEE_DIARY_PATH", str(tmp_path / "api-coffee.json"))
    import panel_agent.main as module
    return importlib.reload(module)


def api_bean_payload(name: str = "API кофе", **overrides):
    payload = {
        "name": name,
        "grindDescription": "Чуть мельче среднего",
        "preferredDrink": "espresso",
        "notes": "Шоколад и ягоды",
    }
    return {**payload, **overrides}


def api_extraction_payload(**overrides):
    payload = {
        "brewedAt": "2026-08-28T10:00:00Z",
        "doseGrams": 17.5,
        "extractionSeconds": 27,
        "yieldGrams": 36.0,
        "notes": "Сладко, хороший баланс",
        "rating": None,
        "makeFavorite": False,
    }
    return {**payload, **overrides}


def test_api_uses_fixed_routes_canonical_shape_and_favourite_headers(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        missing_key = client.post("/api/v1/coffee-diary/beans", json=api_bean_payload())
        assert missing_key.status_code == 428
        created = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": "api-bean-0001"}, json=api_bean_payload())
        assert created.status_code == 201
        bean = created.json()
        assert "defaultRecipe" not in bean
        assert bean["grindDescription"] == "Чуть мельче среднего"
        assert bean["preferredDrink"] == "espresso"
        assert bean["favoriteExtractionId"] is None and bean["photoIds"] == []
        assert created.headers["etag"] == '"1"'
        unknown = client.patch(f"/api/v1/coffee-diary/beans/{bean['id']}", headers={"If-Match": '"1"'}, json={"photoIds": []})
        assert unknown.status_code == 422
        invalid_drink = client.patch(f"/api/v1/coffee-diary/beans/{bean['id']}", headers={"If-Match": '"1"'}, json={"preferredDrink": "filter"})
        assert invalid_drink.status_code == 422
        assert invalid_drink.json()["detail"] == "coffee_diary_preferred_drink_invalid"

        extraction = client.post(
            f"/api/v1/coffee-diary/beans/{bean['id']}/extractions",
            headers={"Idempotency-Key": "api-extract-0001"},
            json=api_extraction_payload(makeFavorite=True),
        )
        assert extraction.status_code == 201
        assert extraction.json()["doseGrams"] == 17.5
        assert extraction.json()["extractionSeconds"] == 27
        assert extraction.json()["yieldGrams"] == 36.0
        assert client.get(f"/api/v1/coffee-diary/beans/{bean['id']}").json()["bean"]["favoriteExtractionId"] == extraction.json()["id"]

        missing_match = client.patch(f"/api/v1/coffee-diary/beans/{bean['id']}/favorite-extraction", json={"extractionId": extraction.json()["id"]})
        assert missing_match.status_code == 428
        favorite = client.patch(
            f"/api/v1/coffee-diary/beans/{bean['id']}/favorite-extraction",
            headers={"If-Match": '"2"'},
            json={"extractionId": None},
        )
        assert favorite.status_code == 200 and favorite.headers["etag"] == '"3"'
        assert favorite.json()["favoriteExtractionId"] is None
        exported = client.get("/api/v1/coffee-diary/export")
        assert exported.status_code == 200 and exported.json()["photos"] == []
        assert not any(getattr(route, "path", "").endswith("/{path}") for route in module.app.routes)


def test_api_grams_precision_is_stable_and_does_not_round(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        bean = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": "api-bean-0002"}, json=api_bean_payload()).json()
        invalid = client.post(
            f"/api/v1/coffee-diary/beans/{bean['id']}/extractions",
            headers={"Idempotency-Key": "api-extract-0002"},
            json=api_extraction_payload(doseGrams=17.15),
        )
        assert invalid.status_code == 422
        assert invalid.json()["detail"] == "coffee_diary_grams_precision_invalid"
        assert client.get("/api/v1/coffee-diary").json()["extractionCount"] == 0


def test_api_extraction_idempotency_is_target_aware_and_stable(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        bean_a = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": "api-bean-0005"}, json=api_bean_payload("A")).json()
        bean_b = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": "api-bean-0006"}, json=api_bean_payload("B")).json()
        payload = api_extraction_payload(makeFavorite=True)
        first = client.post(f"/api/v1/coffee-diary/beans/{bean_a['id']}/extractions", headers={"Idempotency-Key": "api-extract-0005"}, json=payload)
        replay = client.post(f"/api/v1/coffee-diary/beans/{bean_a['id']}/extractions", headers={"Idempotency-Key": "api-extract-0005"}, json=payload)
        assert first.status_code == replay.status_code == 201
        assert replay.json()["id"] == first.json()["id"]
        cross_bean = client.post(f"/api/v1/coffee-diary/beans/{bean_b['id']}/extractions", headers={"Idempotency-Key": "api-extract-0005"}, json=payload)
        assert cross_bean.status_code == 409
        assert cross_bean.json()["detail"] == "coffee_diary_idempotency_key_reused"
        changed_body = client.post(f"/api/v1/coffee-diary/beans/{bean_a['id']}/extractions", headers={"Idempotency-Key": "api-extract-0005"}, json=api_extraction_payload(makeFavorite=False, doseGrams=18.0))
        assert changed_body.status_code == 409
        assert changed_body.json()["detail"] == "coffee_diary_idempotency_key_reused"
        canonical = client.get(f"/api/v1/coffee-diary/beans/{bean_a['id']}").json()
        assert canonical["bean"]["favoriteExtractionId"] == first.json()["id"]
        assert len(canonical["extractions"]) == 1


def test_api_favourite_relationship_is_cross_bean_safe_and_stale_conflict_is_truthful(monkeypatch, tmp_path):
    module = _api_module(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        bean_a = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": "api-bean-0003"}, json=api_bean_payload("A")).json()
        bean_b = client.post("/api/v1/coffee-diary/beans", headers={"Idempotency-Key": "api-bean-0004"}, json=api_bean_payload("B")).json()
        extraction_a = client.post(f"/api/v1/coffee-diary/beans/{bean_a['id']}/extractions", headers={"Idempotency-Key": "api-extract-0003"}, json=api_extraction_payload()).json()
        extraction_b = client.post(f"/api/v1/coffee-diary/beans/{bean_b['id']}/extractions", headers={"Idempotency-Key": "api-extract-0004"}, json=api_extraction_payload()).json()

        cross = client.patch(
            f"/api/v1/coffee-diary/beans/{bean_a['id']}/favorite-extraction",
            headers={"If-Match": '"1"'},
            json={"extractionId": extraction_b["id"]},
        )
        assert cross.status_code == 422
        assert cross.json()["detail"] == "coffee_diary_extraction_belongs_to_another_bean"

        external = client.patch(f"/api/v1/coffee-diary/beans/{bean_a['id']}", headers={"If-Match": '"1"'}, json={"notes": "v2"})
        assert external.status_code == 200
        stale = client.patch(
            f"/api/v1/coffee-diary/beans/{bean_a['id']}/favorite-extraction",
            headers={"If-Match": '"1"'},
            json={"extractionId": extraction_a["id"]},
        )
        assert stale.status_code == 409 and stale.json()["detail"] == "revision_conflict"
        canonical = client.get(f"/api/v1/coffee-diary/beans/{bean_a['id']}").json()["bean"]
        assert canonical["version"] == 2 and canonical["favoriteExtractionId"] is None
