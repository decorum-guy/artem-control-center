from __future__ import annotations

import inspect
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.knowledge import (
    COFFEE_GUIDE_DOCUMENT_ID,
    COFFEE_GUIDE_FILENAME,
    KNOWLEDGE_SCHEMA_VERSION,
    MAX_DOCUMENT_BYTES,
    KnowledgeReader,
    build_knowledge_router,
    resolve_knowledge_root,
)


def knowledge_root(tmp_path):
    root = tmp_path / "knowledge"
    root.mkdir()
    return root


def write_guide(root, content: bytes) -> None:
    (root / COFFEE_GUIDE_FILENAME).write_bytes(content)


def make_client(root) -> TestClient:
    app = FastAPI()
    app.include_router(build_knowledge_router(KnowledgeReader(root)))
    return TestClient(app)


def assert_document_shape(payload: dict) -> None:
    assert set(payload) == {
        "schemaVersion",
        "documentId",
        "status",
        "content",
        "byteSize",
        "modifiedAt",
    }
    assert payload["schemaVersion"] == KNOWLEDGE_SCHEMA_VERSION
    assert payload["documentId"] == COFFEE_GUIDE_DOCUMENT_ID


def make_symlink(link, target):
    try:
        link.symlink_to(target)
    except OSError as exc:
        pytest.skip(f"symlink creation is unavailable in this test environment: {exc}")


def test_missing_local_appdata_is_unavailable_and_does_not_fall_back_to_cwd(
    monkeypatch,
):
    monkeypatch.delenv("LOCALAPPDATA", raising=False)

    result = KnowledgeReader().read_coffee_guide()

    assert result.status == "unavailable"
    assert result.content is None


def test_default_knowledge_root_uses_the_existing_runtime_convention(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    assert resolve_knowledge_root() == tmp_path / "ArtemControlCenter" / "knowledge"


def test_missing_knowledge_root_is_unavailable(tmp_path):
    result = KnowledgeReader(tmp_path / "missing-knowledge").read_coffee_guide()

    assert result.status == "unavailable"
    assert result.content is None


def test_existing_knowledge_root_without_guide_is_missing(tmp_path):
    result = KnowledgeReader(knowledge_root(tmp_path)).read_coffee_guide()

    assert result.status == "missing"
    assert result.content is None
    assert result.byte_size is None
    assert result.modified_at is None


def test_valid_utf8_guide_returns_exact_content_and_safe_metadata(tmp_path):
    root = knowledge_root(tmp_path)
    content = "# Owner guide\nDose: 18 g\n"
    write_guide(root, content.encode("utf-8"))

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "available"
    assert result.content == content
    assert result.byte_size == len(content.encode("utf-8"))
    assert result.modified_at is not None
    assert result.modified_at.endswith("Z")
    assert str(tmp_path) not in result.model_dump_json(by_alias=True)


def test_utf8_bom_is_accepted_and_stripped_from_logical_content(tmp_path):
    root = knowledge_root(tmp_path)
    content = "# BOM\n"
    write_guide(root, b"\xef\xbb\xbf" + content.encode("utf-8"))

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "available"
    assert result.content == content
    assert result.byte_size == 3 + len(content.encode("utf-8"))


def test_unicode_and_russian_markdown_is_preserved(tmp_path):
    root = knowledge_root(tmp_path)
    content = "# Кофе\n- Владелец: Артём\n- Заметка: мягкий вкус ☕\n"
    write_guide(root, content.encode("utf-8"))

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "available"
    assert result.content == content


def test_exactly_64_kibibytes_is_accepted(tmp_path):
    root = knowledge_root(tmp_path)
    content = b"x" * MAX_DOCUMENT_BYTES
    write_guide(root, content)

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "available"
    assert result.content == "x" * MAX_DOCUMENT_BYTES
    assert result.byte_size == MAX_DOCUMENT_BYTES


def test_64_kibibytes_plus_one_is_too_large_without_content(tmp_path):
    root = knowledge_root(tmp_path)
    write_guide(root, b"x" * (MAX_DOCUMENT_BYTES + 1))

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "too_large"
    assert result.content is None
    assert result.byte_size is None
    assert result.modified_at is None


def test_invalid_utf8_is_rejected_without_replacement_decoding(tmp_path):
    root = knowledge_root(tmp_path)
    write_guide(root, b"valid prefix\xffinvalid suffix")

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "invalid_utf8"
    assert result.content is None
    assert "�" not in result.model_dump_json(by_alias=True)


def test_directory_at_fixed_filename_is_unavailable(tmp_path):
    root = knowledge_root(tmp_path)
    (root / COFFEE_GUIDE_FILENAME).mkdir()

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "unavailable"
    assert result.content is None


def test_symlink_to_external_file_is_unavailable(tmp_path):
    root = knowledge_root(tmp_path)
    external = tmp_path / "external.md"
    external.write_text("external secret fixture", encoding="utf-8")
    make_symlink(root / COFFEE_GUIDE_FILENAME, external)

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "unavailable"
    assert result.content is None
    assert "external secret fixture" not in result.model_dump_json(by_alias=True)


def test_symlink_to_runtime_env_never_returns_fake_secret(tmp_path):
    root = knowledge_root(tmp_path)
    fake_runtime_env = tmp_path / "runtime.env"
    fake_token = "FAKE_RUNTIME_SECRET_TOKEN_155A"
    fake_runtime_env.write_text(f"PANEL_SECRET={fake_token}\n", encoding="utf-8")
    make_symlink(root / COFFEE_GUIDE_FILENAME, fake_runtime_env)

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "unavailable"
    assert fake_token not in result.model_dump_json(by_alias=True)
    assert str(tmp_path) not in result.model_dump_json(by_alias=True)


def test_fixed_reader_has_no_arbitrary_path_or_filename_api(tmp_path):
    reader = KnowledgeReader(knowledge_root(tmp_path))

    assert list(inspect.signature(KnowledgeReader.read_coffee_guide).parameters) == [
        "self"
    ]
    assert not hasattr(reader, "read_file")
    assert not hasattr(reader, "read_path")
    assert reader.read_coffee_guide().document_id == COFFEE_GUIDE_DOCUMENT_ID


def test_fixed_reader_ignores_external_runtime_env_and_traversal_candidates(tmp_path):
    root = knowledge_root(tmp_path)
    fake_token = "FAKE_TRAVERSAL_SECRET_TOKEN_155A"
    (tmp_path / "runtime.env").write_text(fake_token, encoding="utf-8")

    result = KnowledgeReader(root).read_coffee_guide()

    assert result.status == "missing"
    assert fake_token not in result.model_dump_json(by_alias=True)


def test_repeated_read_reflects_external_file_changes(tmp_path):
    root = knowledge_root(tmp_path)
    write_guide(root, b"first")
    reader = KnowledgeReader(root)

    first = reader.read_coffee_guide()
    write_guide(root, "второй\n".encode("utf-8"))
    second = reader.read_coffee_guide()

    assert first.content == "first"
    assert second.status == "available"
    assert second.content == "второй\n"


def test_file_removed_after_successful_read_becomes_missing(tmp_path):
    root = knowledge_root(tmp_path)
    guide = root / COFFEE_GUIDE_FILENAME
    guide.write_text("current", encoding="utf-8")
    reader = KnowledgeReader(root)

    assert reader.read_coffee_guide().status == "available"
    guide.unlink()
    result = reader.read_coffee_guide()

    assert result.status == "missing"
    assert result.content is None


def test_knowledge_router_exposes_only_the_fixed_route(tmp_path):
    routes = {
        route.path
        for route in build_knowledge_router(KnowledgeReader(knowledge_root(tmp_path))).routes
        if hasattr(route, "path")
    }

    assert "/api/v1/knowledge/coffee-guide" in routes
    assert not any(path.startswith("/api/v1/knowledge/{") for path in routes)
    assert "/api/v1/files/{path}" not in routes


def test_fixed_endpoint_available_response_contract(tmp_path):
    root = knowledge_root(tmp_path)
    content = "# fixed\n"
    write_guide(root, content.encode("utf-8"))

    with make_client(root) as client:
        response = client.get("/api/v1/knowledge/coffee-guide")

    assert response.status_code == 200
    payload = response.json()
    assert_document_shape(payload)
    assert payload["status"] == "available"
    assert payload["content"] == content
    assert payload["byteSize"] == len(content.encode("utf-8"))
    assert response.headers["cache-control"] == "no-store"


def test_fixed_endpoint_missing_response_is_typed_success(tmp_path):
    root = knowledge_root(tmp_path)

    with make_client(root) as client:
        response = client.get("/api/v1/knowledge/coffee-guide")

    assert response.status_code == 200
    payload = response.json()
    assert_document_shape(payload)
    assert payload["documentId"] == "coffee-guide"
    assert payload["status"] == "missing"
    assert payload["content"] is None
    assert payload["byteSize"] is None
    assert payload["modifiedAt"] is None


def test_fixed_endpoint_too_large_response_has_null_content(tmp_path):
    root = knowledge_root(tmp_path)
    write_guide(root, b"x" * (MAX_DOCUMENT_BYTES + 1))

    with make_client(root) as client:
        response = client.get("/api/v1/knowledge/coffee-guide")

    assert response.status_code == 200
    payload = response.json()
    assert payload["documentId"] == "coffee-guide"
    assert payload["status"] == "too_large"
    assert payload["content"] is None
    assert payload["byteSize"] is None
    assert payload["modifiedAt"] is None


def test_fixed_endpoint_invalid_utf8_response_has_null_content(tmp_path):
    root = knowledge_root(tmp_path)
    write_guide(root, b"prefix\xff")

    with make_client(root) as client:
        response = client.get("/api/v1/knowledge/coffee-guide")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "invalid_utf8"
    assert payload["content"] is None
    assert payload["byteSize"] is None
    assert payload["modifiedAt"] is None


def test_fixed_endpoint_unavailable_response_has_null_content(tmp_path):
    with make_client(tmp_path / "unresolved-root") as client:
        response = client.get("/api/v1/knowledge/coffee-guide")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "unavailable"
    assert payload["content"] is None
    assert payload["byteSize"] is None
    assert payload["modifiedAt"] is None


def test_fixed_endpoint_never_serializes_absolute_root_or_exception_text(tmp_path):
    root = knowledge_root(tmp_path)
    write_guide(root, b"safe content")

    with make_client(root) as client:
        response = client.get("/api/v1/knowledge/coffee-guide")

    serialized = json.dumps(response.json(), ensure_ascii=False)
    assert str(tmp_path) not in serialized
    assert "Traceback" not in serialized
    assert "FileNotFoundError" not in serialized


def test_fixed_endpoint_never_serializes_outside_secret_fixture(tmp_path):
    root = knowledge_root(tmp_path)
    fake_token = "FAKE_OUTSIDE_SECRET_TOKEN_155A"
    (tmp_path / "runtime.env").write_text(fake_token, encoding="utf-8")

    with make_client(root) as client:
        for path in (
            "/api/v1/knowledge/coffee-guide",
            "/api/v1/knowledge/runtime.env",
            "/api/v1/files/runtime.env",
        ):
            response = client.get(path)
            assert fake_token not in response.text


def test_fixed_endpoint_rejects_symlink_to_runtime_env(tmp_path):
    root = knowledge_root(tmp_path)
    fake_token = "FAKE_SYMLINK_SECRET_TOKEN_155A"
    fake_runtime_env = tmp_path / "runtime.env"
    fake_runtime_env.write_text(fake_token, encoding="utf-8")
    make_symlink(root / COFFEE_GUIDE_FILENAME, fake_runtime_env)

    with make_client(root) as client:
        response = client.get("/api/v1/knowledge/coffee-guide")

    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert response.json()["content"] is None
    assert fake_token not in response.text
    assert str(tmp_path) not in response.text


def test_no_arbitrary_file_endpoint_exists_and_traversal_is_not_served(tmp_path):
    root = knowledge_root(tmp_path)
    fake_token = "FAKE_TRAVERSAL_SECRET_TOKEN_155A"
    (tmp_path / "runtime.env").write_text(fake_token, encoding="utf-8")

    with make_client(root) as client:
        responses = [
            client.get("/api/v1/knowledge/runtime.env"),
            client.get("/api/v1/knowledge/%2e%2e/runtime.env"),
            client.get("/api/v1/knowledge/../runtime.env"),
        ]

    assert all(response.status_code == 404 for response in responses)
    assert all(fake_token not in response.text for response in responses)


def test_selector_like_query_parameters_cannot_change_fixed_document(tmp_path):
    root = knowledge_root(tmp_path)
    write_guide(root, b"fixed")
    fake_token = "FAKE_SELECTOR_SECRET_TOKEN_155A"
    (tmp_path / "runtime.env").write_text(fake_token, encoding="utf-8")

    with make_client(root) as client:
        response = client.get(
            "/api/v1/knowledge/coffee-guide"
            "?path=../runtime.env&file=runtime.env&id=runtime.env&document=runtime.env"
        )
        normal = client.get("/api/v1/knowledge/coffee-guide")

    assert response.status_code == 400
    assert fake_token not in response.text
    assert normal.status_code == 200
    assert normal.json()["content"] == "fixed"


def test_fixed_endpoint_is_get_only_and_never_a_write_surface(tmp_path):
    root = knowledge_root(tmp_path)
    write_guide(root, b"fixed")

    with make_client(root) as client:
        post = client.post("/api/v1/knowledge/coffee-guide", content=b"upload")
        delete = client.delete("/api/v1/knowledge/coffee-guide")

    assert post.status_code == 405
    assert delete.status_code == 405
    assert (root / COFFEE_GUIDE_FILENAME).read_bytes() == b"fixed"
