from __future__ import annotations

import hashlib
import json
import threading
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.access_policy import AccessPolicyStore
from panel_agent.backups import (
    BACKUP_PROFILE_CATALOG,
    PANEL_SOURCE_ITEMS,
    PROFILE_ID,
    BackupEngine,
    BackupFailure,
    BackupRequestError,
    PanelConfigSource,
    build_backup_router,
)
from panel_agent.settings import IntegrationSettings


def make_source(root: Path, *, write_ids: set[str] | None = None) -> tuple[PanelConfigSource, dict[str, Path]]:
    root.mkdir(parents=True, exist_ok=True)
    paths = {
        item.logical_id: root / f"{item.logical_id.replace('.', '-')}.state"
        for item in PANEL_SOURCE_ITEMS
    }
    for logical_id in set(paths) if write_ids is None else write_ids:
        paths[logical_id].write_text(f"state:{logical_id}\n", encoding="utf-8")
    return PanelConfigSource(paths), paths


def make_engine(
    tmp_path: Path,
    *,
    write_ids: set[str] | None = None,
    **kwargs,
) -> tuple[BackupEngine, Path, PanelConfigSource]:
    source, _ = make_source(tmp_path / "sources", write_ids=write_ids)
    return (
        BackupEngine(source, tmp_path / "backups", min_free_bytes=1, **kwargs),
        tmp_path / "backups",
        source,
    )


def successful_archive(root: Path) -> Path:
    archives = list(root.rglob("*.zip"))
    assert len(archives) == 1
    return archives[0]


def history(root: Path) -> dict:
    return json.loads((root / "backup-history.v1.json").read_text(encoding="utf-8"))


def test_success_creates_verified_zip_manifest_and_history(tmp_path: Path):
    engine, root, _ = make_engine(tmp_path)

    result = engine.run_sync()

    assert result["state"] == "success"
    assert result["result"] == "success"
    assert result["verificationStatus"] == "verified"
    archive = successful_archive(root)
    manifest_path = next(root.rglob("*.manifest.json"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    archive_bytes = archive.read_bytes()
    assert manifest["schemaVersion"] == "backup.manifest.v1"
    assert manifest["artifactFilename"] == archive.name
    assert manifest["byteSize"] == len(archive_bytes)
    assert manifest["sha256"] == hashlib.sha256(archive_bytes).hexdigest()
    assert manifest["destinationId"] == "laptop-primary"
    assert manifest["result"] == "success"

    with zipfile.ZipFile(archive) as opened:
        names = opened.namelist()
        assert names == [item.member_name for item in PANEL_SOURCE_ITEMS]
        assert all(".." not in name and not name.startswith("/") and "\\" not in name for name in names)
        for item in PANEL_SOURCE_ITEMS:
            assert opened.read(item.member_name)

    saved_history = history(root)
    assert saved_history["schemaVersion"] == "backup.history.v1"
    assert saved_history["entries"][0]["result"] == "success"
    assert saved_history["entries"][0]["sha256"] == manifest["sha256"]
    assert not list(root.rglob("*.partial"))


def test_missing_optional_state_is_truthful(tmp_path: Path):
    engine, root, _ = make_engine(tmp_path, write_ids={"overview.layout", "project.registry"})

    result = engine.run_sync()

    assert result["state"] == "success"
    assert result["includedSourceIds"] == ["overview.layout", "project.registry"]
    assert result["missingOptionalSourceIds"] == [
        "calendar.display-colors",
        "device.visibility",
        "interface.copy",
        "capability.overrides",
    ]
    with zipfile.ZipFile(successful_archive(root)) as opened:
        assert set(opened.namelist()) == {
            "panel-config/overview-layout.json",
            "panel-config/projects.yaml",
        }


def test_only_fixed_allowlist_enters_archive(tmp_path: Path):
    source, paths = make_source(tmp_path / "sources")
    secret = tmp_path / "sources" / ".env"
    secret.write_text("PANEL_TOKEN=do-not-copy\n", encoding="utf-8")
    source_with_extra = PanelConfigSource({**paths, "secret": secret})
    engine = BackupEngine(source_with_extra, tmp_path / "backups", min_free_bytes=1)

    result = engine.run_sync()

    assert result["state"] == "success"
    with zipfile.ZipFile(successful_archive(tmp_path / "backups")) as opened:
        names = set(opened.namelist())
        assert ".env" not in names
        assert all(name in {item.member_name for item in PANEL_SOURCE_ITEMS} for name in names)
        assert all(b"do-not-copy" not in opened.read(name) for name in names)


def test_symlink_source_is_not_followed(tmp_path: Path):
    source, paths = make_source(tmp_path / "sources", write_ids=set())
    target = tmp_path / "secret.json"
    target.write_text("private", encoding="utf-8")
    try:
        paths["overview.layout"].symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available on this platform")
    engine = BackupEngine(source, tmp_path / "backups", min_free_bytes=1)

    result = engine.run_sync()

    assert result["state"] == "failed"
    assert result["errorCode"] == "backup_source_not_allowed"
    assert not list((tmp_path / "backups").rglob("*.zip"))


def test_destination_unavailable_publishes_no_success(tmp_path: Path):
    source, _ = make_source(tmp_path / "sources")
    root = tmp_path / "backup-root-file"
    root.write_text("not a directory", encoding="utf-8")
    engine = BackupEngine(source, root, min_free_bytes=1)

    result = engine.run_sync()

    assert result["state"] == "failed"
    assert result["errorCode"] == "backup_destination_unavailable"
    assert not (root / "backup-history.v1.json").exists()
    assert engine.api_payload()["profiles"][0]["available"] is False


def test_low_free_space_stops_before_source_execution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    source, paths = make_source(tmp_path / "sources", write_ids=set())
    paths["overview.layout"].write_text("source should not be read", encoding="utf-8")
    engine = BackupEngine(source, tmp_path / "backups", min_free_bytes=10)
    monkeypatch.setattr(
        "panel_agent.backups.shutil.disk_usage",
        lambda _root: SimpleNamespace(total=100, used=99, free=1),
    )

    result = engine.run_sync()

    assert result["state"] == "failed"
    assert result["errorCode"] == "backup_insufficient_free_space"
    assert result["includedSourceIds"] == []
    assert not list((tmp_path / "backups").rglob("*.zip"))


def test_archive_failure_leaves_no_successful_artifact_or_history_row(tmp_path: Path):
    def fail_writer(_target: Path, _contents):
        raise OSError("simulated temp failure")

    engine, root, _ = make_engine(tmp_path, archive_writer=fail_writer)

    result = engine.run_sync()

    assert result["state"] == "failed"
    assert result["result"] == "failed"
    assert not list(root.rglob("*.zip"))
    assert not list(root.rglob("*.manifest.json"))
    assert all(entry["result"] != "success" for entry in history(root)["entries"])


def test_verification_failure_cannot_produce_success(tmp_path: Path):
    def fail_verification(_archive: Path):
        raise BackupFailure("backup_verification_failed")

    engine, root, _ = make_engine(tmp_path, verification_hook=fail_verification)

    result = engine.run_sync()

    assert result["state"] == "failed"
    assert result["errorCode"] == "backup_verification_failed"
    assert not list(root.rglob("*.zip"))
    assert not list(root.rglob("*.manifest.json"))
    assert all(entry["result"] != "success" for entry in history(root)["entries"])


def test_history_is_bounded_and_atomically_readable(tmp_path: Path):
    engine, root, _ = make_engine(tmp_path)

    for _ in range(55):
        assert engine.run_sync()["result"] == "success"

    saved = history(root)
    assert len(saved["entries"]) == 50
    assert all(entry["result"] == "success" for entry in saved["entries"])
    assert not list(root.rglob("*.partial"))
    assert engine.api_payload()["history"]["available"] is True


def test_corrupt_history_is_unavailable_and_not_overwritten(tmp_path: Path):
    source, _ = make_source(tmp_path / "sources")
    root = tmp_path / "backups"
    root.mkdir()
    history_path = root / "backup-history.v1.json"
    corrupt_bytes = b'{"schemaVersion":"not-supported","entries":[]}'
    history_path.write_bytes(corrupt_bytes)
    engine = BackupEngine(source, root, min_free_bytes=1)

    result = engine.run_sync()

    assert result["state"] == "failed"
    assert result["errorCode"] == "backup_history_unavailable"
    assert history_path.read_bytes() == corrupt_bytes
    assert engine.api_payload()["history"] == {
        "schemaVersion": "backup.history.v1",
        "available": False,
        "entries": [],
        "errorCode": "backup_history_unavailable",
    }


def test_history_symlink_is_unavailable_and_not_followed(tmp_path: Path):
    if not hasattr(Path, "symlink_to"):
        pytest.skip("symlinks are not available on this platform")
    source, _ = make_source(tmp_path / "sources")
    root = tmp_path / "backups"
    root.mkdir()
    external = tmp_path / "external-history.json"
    external.write_bytes(b"outside-history")
    history_path = root / "backup-history.v1.json"
    try:
        history_path.symlink_to(external)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available on this platform")

    engine = BackupEngine(source, root, min_free_bytes=1)

    result = engine.run_sync()

    assert result["state"] == "failed"
    assert result["errorCode"] == "backup_history_unavailable"
    assert history_path.is_symlink()
    assert external.read_bytes() == b"outside-history"


def test_backup_settings_bound_root_and_free_space(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setenv("PANEL_BACKUP_LOCAL_ROOT", "x" * 1025)
    monkeypatch.setenv("PANEL_BACKUP_MIN_FREE_BYTES", "0")

    settings = IntegrationSettings.from_env()

    assert settings.backup_local_root == ""
    assert settings.backup_min_free_bytes == 1 * 1024 * 1024


def test_concurrent_second_run_is_rejected(tmp_path: Path):
    exporting = threading.Event()
    release = threading.Event()

    def lifecycle(state: str):
        if state == "exporting":
            exporting.set()
            release.wait(timeout=3)

    engine, root, _ = make_engine(tmp_path, lifecycle_hook=lifecycle)
    first = engine.start()
    assert exporting.wait(timeout=3)
    with pytest.raises(BackupRequestError) as error:
        engine.start()
    assert getattr(error.value, "code", None) == "backup_busy"
    release.set()
    assert engine._thread is not None
    engine._thread.join(timeout=3)
    assert engine.api_payload()["currentRun"]["backupId"] == first["backupId"]
    assert engine.api_payload()["currentRun"]["result"] == "success"
    assert successful_archive(root).exists()


def test_server_owned_catalog_registers_only_the_fixed_executable_profile():
    profile = BACKUP_PROFILE_CATALOG.get(PROFILE_ID)

    assert profile is not None
    assert profile.id == PROFILE_ID
    assert profile.project == "artem-control-center"
    assert profile.environment == "local-panel"
    assert profile.service == "panel-agent"
    assert profile.registered is True
    assert profile.executable is True
    assert BACKUP_PROFILE_CATALOG.is_registered("avalar-main-site") is False
    assert BACKUP_PROFILE_CATALOG.is_registered("avalar-stage-site") is False
    assert BACKUP_PROFILE_CATALOG.is_executable("avalar-main-site") is False
    assert BACKUP_PROFILE_CATALOG.is_executable("avalar-stage-site") is False


@pytest.mark.parametrize("profile_id", ["avalar-main-site", "avalar-stage-site"])
def test_declared_avalar_profile_ids_cannot_start_the_fixed_engine(tmp_path: Path, profile_id: str):
    engine, root, _ = make_engine(tmp_path)

    with pytest.raises(BackupRequestError) as error:
        engine.run_sync(profile_id)

    assert getattr(error.value, "code", None) == "backup_profile_unknown"
    assert not root.exists()


def test_unknown_profile_is_rejected_without_execution(tmp_path: Path):
    engine, root, _ = make_engine(tmp_path)

    with pytest.raises(BackupRequestError) as error:
        engine.run_sync("arbitrary-profile")

    assert getattr(error.value, "code", None) == "backup_profile_unknown"
    assert not root.exists()


def test_api_access_is_required_and_response_is_sanitized(tmp_path: Path):
    engine, root, _ = make_engine(tmp_path)
    policy = AccessPolicyStore(tmp_path / "access-policy.json", audit_dir=tmp_path / "audit")
    app = FastAPI()
    app.include_router(build_backup_router(engine, policy))

    with TestClient(app) as client:
        denied = client.post("/api/v1/backups/artem-control-center-config/runs")
        assert denied.status_code == 403
        assert denied.json() == {"detail": "profile_blocked"}
        inventory = client.get("/api/v1/backups")
        assert inventory.status_code == 200
        assert str(root) not in inventory.text
        assert "PANEL_BACKUP_LOCAL_ROOT" not in inventory.text

        policy.set_pin("2468")
        policy.set_profile("full", pin="2468")
        accepted = client.post("/api/v1/backups/artem-control-center-config/runs")
        assert accepted.status_code == 202
        assert accepted.json()["run"]["profileId"] == "artem-control-center-config"
        assert accepted.json()["run"]["backupId"]

    assert engine._thread is not None
    engine._thread.join(timeout=3)
    assert history(root)["entries"][0]["result"] == "success"


def test_api_unknown_profile_is_bounded(tmp_path: Path):
    engine, _, _ = make_engine(tmp_path)
    policy = AccessPolicyStore(tmp_path / "access-policy.json")
    policy.set_pin("2468")
    policy.set_profile("full", pin="2468")
    app = FastAPI()
    app.include_router(build_backup_router(engine, policy))

    response = TestClient(app).post("/api/v1/backups/user-supplied-path/runs")

    assert response.status_code == 404
    assert response.json() == {"detail": "backup_profile_unknown"}
