from __future__ import annotations

import hashlib
import json
import threading
import io
import subprocess
import tarfile
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
    AvalarStageBackupEngine,
    BackupService,
    PanelConfigSource,
    _parse_sha256_inventory,
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


def test_server_owned_catalog_registers_only_fixed_executable_profiles():
    profile = BACKUP_PROFILE_CATALOG.get(PROFILE_ID)

    assert profile is not None
    assert profile.id == PROFILE_ID
    assert profile.project == "artem-control-center"
    assert profile.environment == "local-panel"
    assert profile.service == "panel-agent"
    assert profile.registered is True
    assert profile.executable is True
    assert BACKUP_PROFILE_CATALOG.is_registered("avalar-main-site") is False
    assert BACKUP_PROFILE_CATALOG.is_registered("avalar-stage-site") is True
    assert BACKUP_PROFILE_CATALOG.is_executable("avalar-main-site") is False
    assert BACKUP_PROFILE_CATALOG.is_executable("avalar-stage-site") is True


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


def _stage_archive(
    *,
    manifest_patch: dict | None = None,
    manifest_remove: set[str] | None = None,
    data: bytes = b'{"items":[]}',
    checksum_override: bytes | None = None,
    include_uploads_dir: bool = True,
    extra_entries: tuple[tuple[str, bytes | None, bytes | None, str], ...] = (),
) -> tuple[bytes, dict]:
    source_commit = "a" * 40
    helper_sha = "b" * 64
    uploads = {
        "uploads/one.txt": b"one",
        "uploads/nested/two.txt": b"two",
        "uploads/space name.txt": b"space",
        "uploads/back\\slash.txt": b"backslash",
    }
    checksum_lines = [hashlib.sha256(data).hexdigest() + "  data.json"]
    for name, body in uploads.items():
        digest = hashlib.sha256(body).hexdigest()
        checksum_lines.append(
            "\\" + digest + "  " + name.replace("\\", "\\\\")
            if "\\" in name else digest + "  " + name
        )
    checksums = checksum_override if checksum_override is not None else ("\n".join(checksum_lines) + "\n").encode()
    internal = {
        "schemaVersion": "avalar.stage.backup.v1", "profileId": "avalar-stage-site",
        "project": "avalar-site", "environment": "stage", "service": "website",
        "sourceBranch": "stage", "sourceCommit": source_commit,
        "helperContract": "avalar.stage.backup.v1", "helperSha256": helper_sha,
        "includedScopes": ["data.json", "uploads"],
        "excludedScopes": ["git", "legacy-backups", "secrets", "external-config", "control-center-state"],
        "createdAt": "2026-09-14T00:00:00Z",
    }
    if manifest_patch:
        internal.update(manifest_patch)
    if manifest_remove:
        for key in manifest_remove:
            internal.pop(key, None)
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        directories = ("uploads/", "uploads/nested/") if include_uploads_dir else ("uploads/nested/",)
        for name in directories:
            info = tarfile.TarInfo(name); info.type = tarfile.DIRTYPE; archive.addfile(info)
        for name, body in (("backup.manifest.json", json.dumps(internal).encode()), ("source-files.sha256", checksums), ("data.json", data), *uploads.items()):
            info = tarfile.TarInfo(name); info.size = len(body); archive.addfile(info, io.BytesIO(body))
        for name, body, member_type, linkname in extra_entries:
            info = tarfile.TarInfo(name)
            info.type = member_type or tarfile.REGTYPE
            info.linkname = linkname
            if body is not None:
                info.size = len(body)
            archive.addfile(info, io.BytesIO(body) if body is not None else None)
    artifact = stream.getvalue()
    return artifact, {"ok": True, "schemaVersion": "avalar.stage.backup.transport.v1", "profileId": "avalar-stage-site", "helperContract": "avalar.stage.backup.v1", "byteSize": len(artifact), "sha256": hashlib.sha256(artifact).hexdigest(), "sourceCommit": source_commit, "helperSha256": helper_sha}


class _FakeProcess:
    def __init__(self, archive: bytes, metadata: dict, returncode: int = 0, stderr: bytes | None = None, timeout: bool = False):
        self.stdout, self.stderr = io.BytesIO(archive), io.BytesIO(stderr if stderr is not None else json.dumps(metadata).encode())
        self.returncode = returncode
        self.timeout = timeout
    def wait(self, timeout=None):
        if self.timeout: raise subprocess.TimeoutExpired("ssh", timeout)
        return self.returncode
    def poll(self): return self.returncode
    def kill(self): self.returncode = -9


def _run_stage_archive(tmp_path: Path, archive: bytes, metadata: dict) -> dict:
    engine = AvalarStageBackupEngine(
        tmp_path / "backups", enabled=True, ssh_host="avalar-backup",
        ssh_command="control-center", timeout_seconds=180, min_free_bytes=1,
        popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata),
    )
    return engine.run_sync()


def test_stage_transport_is_binary_safe_and_publishes_only_after_verification(tmp_path: Path):
    archive, metadata = _stage_archive(); seen = []
    def popen(argv, **kwargs):
        seen.append((argv, kwargs)); return _FakeProcess(archive, metadata)
    engine = AvalarStageBackupEngine(tmp_path / "backups", enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1, popen_factory=popen)
    result = engine.run_sync()
    assert result["result"] == "success"
    assert result["sourceCommit"] == "a" * 40
    saved = next((tmp_path / "backups").rglob("*.tar.gz"))
    assert saved.read_bytes() == archive
    with tarfile.open(saved, "r:gz") as opened:
        members = opened.getmembers()
        assert members[0].isdir() and members[1].isdir()
        assert [member.name for member in members] == [
            "uploads", "uploads/nested", "backup.manifest.json",
            "source-files.sha256", "data.json", "uploads/one.txt",
            "uploads/nested/two.txt", "uploads/space name.txt",
            "uploads/back\\slash.txt",
        ]
    assert seen[0][0] == ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "avalar-backup", "control-center", "backup-stage"]
    assert seen[0][1]["shell"] is False
    assert not list((tmp_path / "backups").rglob("*.partial"))


def test_stage_rejects_bad_transport_digest_without_publication(tmp_path: Path):
    archive, metadata = _stage_archive(); metadata["sha256"] = "c" * 64
    engine = AvalarStageBackupEngine(tmp_path / "backups", enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1, popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata))
    result = engine.run_sync()
    assert result["errorCode"] == "backup_transport_invalid"
    assert not list((tmp_path / "backups").rglob("*.tar.gz"))


@pytest.mark.parametrize(("stderr", "error"), [(b"not-json", "backup_transport_invalid"), (b"x" * (16 * 1024 + 1), "backup_transport_invalid")])
def test_stage_rejects_malformed_or_overflow_metadata(tmp_path: Path, stderr: bytes, error: str):
    archive, metadata = _stage_archive()
    engine = AvalarStageBackupEngine(tmp_path / "backups", enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1, popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata, stderr=stderr))
    result = engine.run_sync()
    assert result["errorCode"] == error
    assert not list((tmp_path / "backups").rglob("*.partial"))


def test_stage_timeout_cleans_partial(tmp_path: Path):
    archive, metadata = _stage_archive()
    engine = AvalarStageBackupEngine(tmp_path / "backups", enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=10, min_free_bytes=1, popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata, timeout=True))
    assert engine.run_sync()["errorCode"] == "backup_remote_timeout"
    assert not list((tmp_path / "backups").rglob("*.partial"))


@pytest.mark.parametrize(("name", "patch", "remove"), [
    ("extra", {"extra": True}, None),
    ("missing", None, {"helperSha256"}),
    ("timestamp", {"createdAt": "2026-09-14T00:00:00+03:00"}, None),
])
def test_stage_rejects_noncanonical_internal_manifest(tmp_path: Path, name: str, patch: dict | None, remove: set[str] | None):
    archive, metadata = _stage_archive(manifest_patch=patch, manifest_remove=remove)
    assert _run_stage_archive(tmp_path, archive, metadata)["errorCode"] == "backup_verification_failed"


def test_stage_accepts_exact_b2a_manifest_timestamp(tmp_path: Path):
    archive, metadata = _stage_archive(manifest_patch={"createdAt": "2026-12-31T23:59:59Z"})
    assert _run_stage_archive(tmp_path, archive, metadata)["result"] == "success"


@pytest.mark.parametrize("extra", [
    ("/absolute", b"x", None, ""),
    ("uploads/../traversal", b"x", None, ""),
    ("uploads/one.txt", b"duplicate", None, ""),
    ("uploads/link", None, tarfile.SYMTYPE, "uploads/one.txt"),
    ("uploads/hard", None, tarfile.LNKTYPE, "uploads/one.txt"),
    ("uploads/fifo", None, tarfile.FIFOTYPE, ""),
    ("uploads/device", None, tarfile.CHRTYPE, ""),
    ("unexpected.txt", b"x", None, ""),
])
def test_stage_rejects_unsafe_archive_members(tmp_path: Path, extra):
    archive, metadata = _stage_archive(extra_entries=(extra,))
    result = _run_stage_archive(tmp_path, archive, metadata)
    assert result["errorCode"] == "backup_verification_failed"
    assert not list((tmp_path / "backups").rglob("*.tar.gz"))


def test_stage_rejects_regular_uploads_and_missing_uploads_directory(tmp_path: Path):
    archive, metadata = _stage_archive(include_uploads_dir=False, extra_entries=(("uploads", b"not-a-directory", None, ""),))
    assert _run_stage_archive(tmp_path, archive, metadata)["errorCode"] == "backup_verification_failed"
    archive, metadata = _stage_archive(include_uploads_dir=False)
    assert _run_stage_archive(tmp_path / "missing", archive, metadata)["errorCode"] == "backup_verification_failed"


def test_stage_rejects_invalid_data_json_and_transport_size_mismatch(tmp_path: Path):
    archive, metadata = _stage_archive(data=b"not-json")
    assert _run_stage_archive(tmp_path, archive, metadata)["errorCode"] == "backup_verification_failed"
    archive, metadata = _stage_archive(); metadata["byteSize"] += 1
    result = _run_stage_archive(tmp_path / "size", archive, metadata)
    assert result["errorCode"] == "backup_transport_invalid"
    assert not list((tmp_path / "size" / "backups").rglob("*.tar.gz"))
    assert not list((tmp_path / "size" / "backups").rglob("*.partial"))
    assert all(row["result"] != "success" for row in history(tmp_path / "size" / "backups")["entries"])


@pytest.mark.parametrize("inventory", [
    b"\\" + b"d" * 64 + b"  uploads/a\\q\n",
    b"d" * 64 + b"  data.json\n" + b"d" * 64 + b"  data.json\n",
    b"d" * 64 + b"  ../outside\n",
    b"d" * 64 + b"  data.json\n",
    b"d" * 64 + b"  uploads/missing.txt\n",
    b"d" * 64 + b"  uploads\n",
])
def test_stage_rejects_invalid_checksum_inventory_end_to_end(tmp_path: Path, inventory: bytes):
    archive, metadata = _stage_archive(checksum_override=inventory)
    assert _run_stage_archive(tmp_path, archive, metadata)["errorCode"] == "backup_verification_failed"


def test_stage_rejects_checksum_digest_mismatch_end_to_end(tmp_path: Path):
    inventory = "\n".join([
        "c" * 64 + "  data.json",
        hashlib.sha256(b"one").hexdigest() + "  uploads/one.txt",
        hashlib.sha256(b"two").hexdigest() + "  uploads/nested/two.txt",
        hashlib.sha256(b"space").hexdigest() + "  uploads/space name.txt",
        "\\" + hashlib.sha256(b"backslash").hexdigest() + "  uploads/back\\\\slash.txt",
    ]).encode() + b"\n"
    archive, metadata = _stage_archive(checksum_override=inventory)
    assert _run_stage_archive(tmp_path, archive, metadata)["errorCode"] == "backup_verification_failed"


def test_stage_rejects_duplicate_directory_identity(tmp_path: Path):
    archive, metadata = _stage_archive(extra_entries=(("uploads/", None, tarfile.DIRTYPE, ""),))
    assert _run_stage_archive(tmp_path, archive, metadata)["errorCode"] == "backup_verification_failed"


def test_stage_post_publish_reverification_failure_removes_artifact(tmp_path: Path):
    archive, metadata = _stage_archive()
    def fail_final(path: Path) -> None:
        if path.suffix == ".gz":
            raise BackupFailure("backup_verification_failed")
    engine = AvalarStageBackupEngine(tmp_path / "backups", enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1, popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata), verification_hook=fail_final)
    result = engine.run_sync()
    assert result["errorCode"] == "backup_verification_failed"
    assert not list((tmp_path / "backups").rglob("*.tar.gz"))
    assert not list((tmp_path / "backups").rglob("*.manifest.json"))
    assert all(row["result"] != "success" for row in history(tmp_path / "backups")["entries"])


@pytest.mark.parametrize(("failure_code", "expected"), [
    ("backup_manifest_failed", "backup_manifest_failed"),
    ("backup_history_write_failed", "backup_history_write_failed"),
])
def test_stage_local_persistence_failure_never_publishes_success(tmp_path: Path, failure_code: str, expected: str):
    archive, metadata = _stage_archive()
    def fail_selected(path: Path, payload, maximum: int, code: str) -> None:
        if code == failure_code:
            raise BackupFailure(code)
        from panel_agent.backups import _atomic_json_write
        _atomic_json_write(path, payload, maximum, code)
    engine = AvalarStageBackupEngine(tmp_path / "backups", enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1, popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata), json_writer=fail_selected)
    result = engine.run_sync()
    assert result["errorCode"] == expected
    assert not list((tmp_path / "backups").rglob("*.tar.gz"))
    assert not list((tmp_path / "backups").rglob("*.manifest.json"))


def test_checksum_parser_supports_spaces_and_escaped_backslashes():
    digest = "d" * 64
    assert _parse_sha256_inventory((digest + "  uploads/a file.txt\n\\" + digest + "  uploads/a\\\\b.txt\n").encode()) == {"uploads/a file.txt": digest, "uploads/a\\b.txt": digest}
    with pytest.raises(BackupFailure):
        _parse_sha256_inventory((digest + "  ../bad\n").encode())
    with pytest.raises(BackupFailure):
        _parse_sha256_inventory(("\\" + digest + "  uploads/a\\q.txt\n").encode())


def test_backup_service_serializes_profiles(tmp_path: Path):
    panel, _, _ = make_engine(tmp_path)
    stage = AvalarStageBackupEngine(tmp_path / "backups", enabled=False, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1)
    service = BackupService(panel, stage)
    run = service.start(PROFILE_ID)
    with pytest.raises(BackupRequestError) as error:
        service.start("avalar-stage-site")
    assert run["profileId"] == PROFILE_ID
    assert error.value.code == "backup_busy"


def test_backup_service_rejects_panel_while_stage_is_active(tmp_path: Path):
    archive, metadata = _stage_archive()
    started, release = threading.Event(), threading.Event()
    class BlockingStdout:
        def __init__(self): self.sent = False
        def read(self, _size: int) -> bytes:
            if not self.sent:
                started.set(); assert release.wait(timeout=3); self.sent = True
                return archive
            return b""
    class BlockingProcess(_FakeProcess):
        def __init__(self):
            super().__init__(b"", metadata); self.stdout = BlockingStdout()
    panel, _, _ = make_engine(tmp_path)
    stage = AvalarStageBackupEngine(tmp_path / "backups", enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1, popen_factory=lambda *args, **kwargs: BlockingProcess())
    service = BackupService(panel, stage)
    stage_run = service.start("avalar-stage-site")
    assert stage_run["backupId"] and started.wait(timeout=3)
    with pytest.raises(BackupRequestError) as error:
        service.start(PROFILE_ID)
    assert error.value.code == "backup_busy"
    release.set()
    assert service._thread is not None
    service._thread.join(timeout=3)
    assert service.api_payload()["currentRun"]["backupId"] == stage_run["backupId"]


def test_cross_profile_busy_preserves_seeded_shared_history(tmp_path: Path):
    archive, metadata = _stage_archive()
    root = tmp_path / "backups"
    seed = AvalarStageBackupEngine(root, enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1, popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata))
    assert seed.run_sync()["result"] == "success"
    seeded_id = history(root)["entries"][0]["backupId"]
    started, release = threading.Event(), threading.Event()
    class BlockingStdout:
        def __init__(self): self.sent = False
        def read(self, _size: int) -> bytes:
            if not self.sent:
                started.set(); assert release.wait(timeout=3); self.sent = True; return archive
            return b""
    class BlockingProcess(_FakeProcess):
        def __init__(self): super().__init__(b"", metadata); self.stdout = BlockingStdout()
    panel, _, _ = make_engine(tmp_path)
    stage = AvalarStageBackupEngine(root, enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1, popen_factory=lambda *args, **kwargs: BlockingProcess())
    service = BackupService(panel, stage)
    accepted = service.start("avalar-stage-site")
    assert started.wait(timeout=3)
    with pytest.raises(BackupRequestError) as rejected:
        service.start(PROFILE_ID)
    assert rejected.value.code == "backup_busy"
    release.set(); assert service._thread is not None; service._thread.join(timeout=3)
    rows = history(root)["entries"]
    assert [row["backupId"] for row in rows].count(seeded_id) == 1
    assert [row["backupId"] for row in rows].count(accepted["backupId"]) == 1
    assert len(rows) == 2 and all(row["result"] == "success" for row in rows)


def test_stage_post_returns_the_worker_run_identity_and_main_stays_unknown(tmp_path: Path):
    archive, metadata = _stage_archive()
    panel, _, _ = make_engine(tmp_path)
    stage = AvalarStageBackupEngine(
        tmp_path / "backups", enabled=True, ssh_host="avalar-backup",
        ssh_command="control-center", timeout_seconds=180, min_free_bytes=1,
        popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata),
    )
    service = BackupService(panel, stage)
    policy = AccessPolicyStore(tmp_path / "policy.json")
    policy.set_pin("2468"); policy.set_profile("full", pin="2468")
    app = FastAPI(); app.include_router(build_backup_router(service, policy))
    with TestClient(app) as client:
        accepted = client.post("/api/v1/backups/avalar-stage-site/runs")
        assert accepted.status_code == 202
        run = accepted.json()["run"]
        assert run["schemaVersion"] == "backup.run.v1"
        assert run["backupId"] and run["profileId"] == "avalar-stage-site"
        assert client.post("/api/v1/backups/avalar-main-site/runs").status_code == 404
    assert service._thread is not None
    service._thread.join(timeout=3)
    assert service.api_payload()["currentRun"]["backupId"] == run["backupId"]
    assert service.api_payload()["currentRun"]["result"] == "success"


def test_stage_remote_failure_records_strict_failed_history(tmp_path: Path):
    archive, metadata = _stage_archive()
    engine = AvalarStageBackupEngine(
        tmp_path / "backups", enabled=True, ssh_host="avalar-backup",
        ssh_command="control-center", timeout_seconds=180, min_free_bytes=1,
        popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata, returncode=75),
    )
    result = engine.run_sync()
    assert result["errorCode"] == "backup_remote_busy"
    entry = history(tmp_path / "backups")["entries"][0]
    assert entry["result"] == "failed"
    assert entry["artifactFilename"] is None and entry["sourceCommit"] is None
    assert entry["helperSha256"] is None and entry["errorCode"] == "backup_remote_busy"


@pytest.mark.parametrize(("field", "value"), [
    ("project", "wrong"), ("environment", "wrong"), ("service", "wrong"),
    ("archiveFormat", "zip"),
])
def test_tampered_failed_stage_history_is_unavailable_and_not_overwritten(tmp_path: Path, field: str, value: str):
    archive, metadata = _stage_archive()
    engine = AvalarStageBackupEngine(tmp_path / "backups", enabled=True, ssh_host="avalar-backup", ssh_command="control-center", timeout_seconds=180, min_free_bytes=1, popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata, returncode=75))
    assert engine.run_sync()["errorCode"] == "backup_remote_busy"
    path = tmp_path / "backups" / "backup-history.v1.json"
    document = json.loads(path.read_text()); document["entries"][0][field] = value
    path.write_text(json.dumps(document), encoding="utf-8")
    tampered = path.read_bytes()
    assert engine.run_sync()["errorCode"] == "backup_history_unavailable"
    assert path.read_bytes() == tampered


@pytest.mark.parametrize(("returncode", "error"), [(75, "backup_remote_busy"), (77, "backup_remote_disabled"), (69, "backup_remote_failed")])
def test_stage_maps_remote_return_codes(tmp_path: Path, returncode: int, error: str):
    archive, metadata = _stage_archive()
    engine = AvalarStageBackupEngine(
        tmp_path / "backups", enabled=True, ssh_host="avalar-backup",
        ssh_command="control-center", timeout_seconds=180, min_free_bytes=1,
        popen_factory=lambda *args, **kwargs: _FakeProcess(archive, metadata, returncode=returncode),
    )
    assert engine.run_sync()["errorCode"] == error
