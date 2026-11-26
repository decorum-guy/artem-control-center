#!/usr/bin/env python3
"""Fixed, private Linux deployment adapters. No HTTP listener or shell payloads.

The coordinator has already verified CI. This adapter independently verifies the
repository, latest main SHA, clean source and runtime outcome. Install this file
outside the updating checkouts; protected host configuration supplies all paths.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid

SHA = re.compile(r"[0-9a-f]{40}\Z")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
HA_IMAGE = re.compile(r"ghcr\.io/home-assistant/home-assistant@sha256:[0-9a-f]{64}\Z")
REPOSITORIES = {
    "telegram-bot": "decorum-guy/AliceTG_Bot",
    "home-assistant": "decorum-guy/artem-control-center",
}
HA_COMPONENT_FILES = frozenset({"__init__.py", "request_gateway.py", "manifest.json", "services.yaml"})
MAX_FILE = 1024 * 1024
BOT_SOURCE_DIGESTS = """import hashlib,json,pathlib
root=pathlib.Path('/app')
paths=[root/'requirements.txt',*(root/'app').rglob('*')]
result={}
for path in paths:
 if path.is_file() and '__pycache__' not in path.parts and path.suffix not in {'.pyc','.pyo'}:
  data=path.read_bytes()
  result[str(path.relative_to(root))]=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\\0'+data).hexdigest()
print(json.dumps(result,sort_keys=True))
"""


class DeploymentError(RuntimeError):
    """Only locally selected, content-free codes may escape the adapter."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise DeploymentError(code)


def read_json(path: Path) -> dict[str, Any]:
    require(path.is_file() and not path.is_symlink(), "configuration_missing")
    require(path.stat().st_size <= MAX_FILE, "configuration_too_large")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise DeploymentError("invalid_json") from exc
    require(isinstance(value, dict), "invalid_json")
    return value


def protected(path: Path) -> None:
    require(not path.is_symlink(), "unsafe_file")
    info = path.stat()
    require(info.st_uid in {0, os.geteuid()} and not info.st_mode & 0o022,
            "unprotected_configuration")


def atomic_bytes(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".deploy-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    atomic_bytes(path, (json.dumps(value, sort_keys=True) + "\n").encode())


def relative_file(value: Any) -> str:
    require(isinstance(value, str) and bool(value), "invalid_path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts and
            all(part not in {"", "."} for part in path.parts) and
            "\\" not in value and "\x00" not in value, "invalid_path")
    return value


def contained_file(root: Path, relative: str) -> Path:
    path = root / relative_file(relative)
    require(root.resolve() in path.resolve().parents, "path_outside_root")
    current = path
    while current != root:
        require(not current.is_symlink(), "symlink_not_allowed")
        current = current.parent
    return path


class Runner:
    def run(self, argv: list[str], *, cwd: Path | None = None,
            timeout: int = 120, capture: bool = True, strip_output: bool = True) -> str:
        # Discard build/check output: providers may print env/config values.
        with tempfile.TemporaryFile() as output:
            try:
                process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                                           stdout=output if capture else subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL,
                                           start_new_session=True,
                                           env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
                try:
                    code = process.wait(timeout=timeout)
                except subprocess.TimeoutExpired as exc:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    raise DeploymentError("command_timeout") from exc
            except OSError as exc:
                raise DeploymentError("command_unavailable") from exc
            require(code == 0, "command_failed")
            if not capture:
                return ""
            output.seek(0)
            result = output.read(MAX_FILE + 1)
            require(len(result) <= MAX_FILE, "command_output_too_large")
            try:
                text = result.decode("utf-8")
                return text.strip() if strip_output else text
            except UnicodeError as exc:
                raise DeploymentError("invalid_command_output") from exc


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def local_url(value: Any) -> str:
    require(isinstance(value, str), "invalid_health_url")
    parsed = urlsplit(value)
    try:
        loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
        valid_port = parsed.port is not None and 1 <= parsed.port <= 65535
    except ValueError:
        loopback, valid_port = False, False
    require(parsed.scheme == "http" and loopback and valid_port and
            not parsed.username and not parsed.password and not parsed.query and
            not parsed.fragment, "invalid_health_url")
    return value.rstrip("/")


class Health:
    def __init__(self, target: str, config: dict[str, Any]):
        self.target, self.config = target, config
        self.base = local_url(config["apiUrl"])
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def get(self, path: str) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if self.target == "home-assistant":
            token_file = Path(self.config["tokenFile"])
            protected(token_file)
            require(not token_file.stat().st_mode & 0o077, "unprotected_token")
            token = token_file.read_text(encoding="utf-8").strip()
            require(16 <= len(token) <= 8192 and "\n" not in token and "\r" not in token,
                    "invalid_token")
            headers["Authorization"] = "Bearer " + token
        try:
            with self.opener.open(Request(self.base + path, headers=headers), timeout=5) as response:
                require(response.status == 200, "health_not_ready")
                body = response.read(MAX_FILE + 1)
            require(len(body) <= MAX_FILE, "health_response_too_large")
            result = json.loads(body)
            require(isinstance(result, dict), "health_not_ready")
            return result
        except (URLError, HTTPError, ValueError, OSError) as exc:
            raise DeploymentError("health_not_ready") from exc

    def check(self, *, check_entities: bool = True) -> None:
        if self.target == "telegram-bot":
            data = self.get("/health/ready")
            require(data.get("status") == "ready" and all(data.get(key) == "ready"
                    for key in ("telegram", "home_assistant", "timing_helpers")), "health_not_ready")
        else:
            require(self.get("/api/").get("message") == "API running.", "health_not_ready")
            for entity in self.config.get("expectedEntities", []) if check_entities else []:
                require(bool(re.fullmatch(r"[a-z_]+\.[a-z0-9_]+", entity)), "invalid_entity")
                data = self.get("/api/states/" + entity)
                # A disconnected Samsung legitimately leaves its entity
                # unavailable; configuration loading is the HA deployment gate.
                require(data.get("entity_id") == entity and isinstance(data.get("state"), str),
                        "managed_entity_missing")

    def wait(self, seconds: int = 180, *, check_entities: bool = True) -> None:
        deadline = time.monotonic() + seconds
        while True:
            try:
                self.check(check_entities=check_entities)
                return
            except DeploymentError:
                if time.monotonic() >= deadline:
                    raise DeploymentError("health_timeout") from None
                time.sleep(min(2, max(0, deadline - time.monotonic())))


@contextmanager
def deployment_lock(path: Path):
    import fcntl  # Linux host only; unit imports remain possible on Windows.
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a+") as handle:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise DeploymentError("maintenance_busy") from exc
        yield


class Deployment:
    def __init__(self, target: str, sha: str, config: dict[str, Any], *,
                 runner: Runner | None = None, health: Health | None = None):
        require(target in REPOSITORIES and bool(SHA.fullmatch(sha)), "invalid_target")
        require(config.get("schemaVersion") == 1, "invalid_configuration")
        self.target, self.sha, self.root = target, sha, config
        self.config = config.get("targets", {}).get(target, {})
        require(self.config.get("enabled") is True, "target_disabled")
        require(self.config.get("repository") == REPOSITORIES[target], "wrong_repository")
        self.checkout = Path(self.config["checkout"])
        self.state = Path(config["stateDir"])
        self.compose_dir = Path(self.config["composeProjectDir"])
        for path in (self.checkout, self.state, self.compose_dir, Path(self.config["composeFile"]),
                     Path(self.config["loopbackOverlay"])):
            require(path.is_absolute(), "absolute_path_required")
        require(self.checkout.resolve() not in self.state.resolve().parents,
                "state_inside_checkout")
        service = self.config["service"]
        require(bool(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", service)), "invalid_service")
        self.service = service
        self.runner = runner or Runner()
        self.health = health or Health(target, self.config)
        self.target_state = self.state / target
        self.overlay = self.target_state / "active-image.json"
        self.marker = self.target_state / "installed.json"
        self.journal = self.target_state / "pending.json"
        self.transaction = self.target_state / "transactions" / uuid.uuid4().hex
        self.previous_head = ""
        self.previous_image = ""
        self.previous_revision: str | None = None
        self.runtime_touched = False

    def git(self, *args: str) -> str:
        return self.runner.run(["git", "-C", str(self.checkout), *args], timeout=120)

    def preflight_source(self) -> None:
        require(Path(self.git("rev-parse", "--show-toplevel")).resolve() == self.checkout.resolve(),
                "wrong_checkout")
        remote = self.git("remote", "get-url", "origin")
        repo = REPOSITORIES[self.target]
        require(remote in {"https://github.com/" + repo + ".git", "https://github.com/" + repo,
                           "git@github.com:" + repo + ".git"}, "wrong_origin")
        require(not self.git("status", "--porcelain", "--untracked-files=normal"), "dirty_checkout")
        self.previous_head = self.git("rev-parse", "HEAD")
        require(bool(SHA.fullmatch(self.previous_head)), "invalid_current_revision")
        self.git("fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
        require(self.git("rev-parse", "refs/remotes/origin/main") == self.sha, "main_moved")

    def source(self, path: str) -> bytes:
        path = relative_file(path)
        entry = self.git("ls-tree", self.sha, "--", path)
        require(entry.startswith("100644 blob ") and entry.endswith("\t" + path), "invalid_source_file")
        return self.source_bytes(path)

    def source_bytes(self, path: str) -> bytes:
        return self.runner.run(["git", "-C", str(self.checkout), "show", self.sha + ":" + path],
                               timeout=120, strip_output=False).encode("utf-8")

    def compose(self, *args: str, timeout: int = 120, capture: bool = True) -> str:
        command = ["docker", "compose", "--project-directory", str(self.compose_dir),
                   "-f", self.config["composeFile"], "-f", self.config["loopbackOverlay"]]
        if self.overlay.exists():
            command.extend(["-f", str(self.overlay)])
        return self.runner.run([*command, *args], timeout=timeout, capture=capture)

    def container(self) -> dict[str, Any]:
        identity = self.compose("ps", "-a", "-q", self.service)
        require(bool(re.fullmatch(r"[0-9a-f]{12,64}", identity)), "container_missing")
        try:
            payload = json.loads(self.runner.run(["docker", "inspect", identity]))
        except ValueError as exc:
            raise DeploymentError("invalid_container") from exc
        require(isinstance(payload, list) and len(payload) == 1 and isinstance(payload[0], dict),
                "invalid_container")
        info = payload[0]
        require(bool(IMAGE_ID.fullmatch(info.get("Image", ""))), "invalid_container_image")
        return info

    def image(self, reference: str) -> str:
        value = self.runner.run(["docker", "image", "inspect", "--format", "{{.Id}}", reference])
        require(bool(IMAGE_ID.fullmatch(value)), "invalid_image")
        return value

    def record(self, phase: str, **fields: Any) -> None:
        atomic_json(self.journal, {"schemaVersion": 1, "target": self.target, "revision": self.sha,
                                  "phase": phase, "transaction": str(self.transaction),
                                  "previousRevision": self.previous_head,
                                  "previousImage": self.previous_image, **fields})

    def set_image(self, image: str, *, build: bool = False, revision: str | None = None) -> None:
        value: dict[str, Any] = {"image": image, "labels": {"org.artem.source-revision": revision or self.sha}}
        if build:
            value["build"] = {"context": str(self.checkout),
                              "labels": {"org.opencontainers.image.revision": self.sha}}
        atomic_json(self.overlay, {"services": {self.service: value}})

    def recreate(self) -> None:
        self.runtime_touched = True
        self.compose("up", "-d", "--no-deps", "--no-build", "--pull", "never",
                     "--force-recreate", self.service, timeout=180, capture=False)

    def verify(self, image_id: str, *, rollback: bool = False) -> None:
        info = self.container()
        require(info["Image"] == image_id and info.get("State", {}).get("Running") is True,
                "deployed_image_mismatch")
        self.health.wait(check_entities=not rollback)

    def finish(self, status: str, *, revision: str | None = None, **fields: Any) -> dict[str, Any]:
        result = {"schemaVersion": 1, "target": self.target, "revision": revision or self.sha,
                  "attemptedRevision": self.sha,
                  "status": status, **fields}
        atomic_json(self.transaction / "result.json", result)
        if status in {"deployed", "up_to_date"}:
            atomic_json(self.marker, result)
        self.journal.unlink(missing_ok=True)
        return result

    def run(self) -> dict[str, Any]:
        require(not self.journal.exists(), "previous_attempt_unresolved")
        self.target_state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.transaction.mkdir(parents=True, mode=0o700)
        self.preflight_source()
        self.health.check(check_entities=False)  # New entities need not exist yet.
        before = self.container()
        require(before.get("State", {}).get("Running") is True, "existing_service_not_running")
        self.previous_image = before["Image"]
        label = before.get("Config", {}).get("Labels", {}).get("org.artem.source-revision")
        if self.target == "telegram-bot" and isinstance(label, str) and SHA.fullmatch(label):
            self.previous_revision = label
        elif self.target == "telegram-bot":
            self.previous_revision = self.prove_initial_bot_revision(before)
        elif self.target == "home-assistant" and self.marker.exists():
            previous = read_json(self.marker)
            revision = previous.get("revision")
            hashes = previous.get("fileHashes")
            if (isinstance(revision, str) and SHA.fullmatch(revision) and
                    previous.get("image") == self.previous_image and isinstance(hashes, dict) and
                    all(isinstance(path, str) and self.managed_destination(path) and
                        contained_file(Path(self.config["configDir"]), path).is_file() and
                        hashlib.sha256(contained_file(Path(self.config["configDir"]), path).read_bytes()).hexdigest() == digest
                        for path, digest in hashes.items())):
                self.previous_revision = revision
        if self.overlay.exists():
            shutil.copy2(self.overlay, self.transaction / "previous-overlay.json")
        if self.target == "telegram-bot":
            return self.deploy_bot(before)
        return self.deploy_ha(before)

    def prove_initial_bot_revision(self, before: dict[str, Any]) -> str:
        # Historical bot images have no revision label. Compare immutable image
        # source with Git before trusting a checkout SHA as the rollback base.
        for mount in before.get("Mounts", []):
            destination = mount.get("Destination", "")
            require(destination not in {"/app", "/app/app", "/app/requirements.txt"} and
                    not destination.startswith("/app/app/"), "mutable_bot_source")
        expected: dict[str, str] = {}
        for line in self.git("ls-tree", "-r", self.previous_head, "--", "app", "requirements.txt").splitlines():
            metadata, path = line.split("\t", 1)
            mode, kind, blob = metadata.split(" ")
            require(mode in {"100644", "100755"} and kind == "blob" and
                    bool(SHA.fullmatch(blob)), "invalid_bot_source")
            expected[path] = blob
        require("requirements.txt" in expected and any(path.startswith("app/") for path in expected),
                "invalid_bot_source")
        actual = json.loads(self.compose("exec", "-T", self.service, "python", "-c", BOT_SOURCE_DIGESTS))
        require(actual == expected, "runtime_revision_unverified")
        return self.previous_head

    def deploy_bot(self, before: dict[str, Any]) -> dict[str, Any]:
        if self.previous_head == self.sha and before.get("Config", {}).get("Labels", {}).get(
                "org.artem.source-revision") == self.sha:
            return self.finish("up_to_date", image=self.previous_image)
        # Unknown schema changes cannot safely be rolled back to an older bot.
        baseline = self.previous_revision or self.previous_head
        changed = self.git("diff", "--name-only", baseline, self.sha, "--",
                           "app/planning/sql", "app/planning/migrations.py", "app/planning/db.py")
        require(not changed, "database_migration_requires_review")
        backup = json.loads(self.compose("exec", "-T", self.service, "python", "-m",
                                         "app.planning.backup", "backup", timeout=180))
        name = backup.get("package", "")
        require(backup.get("ok") is True and bool(re.fullmatch(
            r"planning-\d{8}T\d{6}Z-schema\d+-[0-9a-f]{12}\.sqlite3\.a8", name)),
            "planning_backup_failed")
        verified = json.loads(self.compose("exec", "-T", self.service, "python", "-m",
                                           "app.planning.backup", "verify", name, timeout=180))
        require(verified.get("ok") is True, "planning_backup_unverified")
        self.record("prepared", planningBackup=name)
        try:
            self.git("checkout", "--detach", self.sha)
            candidate = "artem-auto/telegram-bot:" + self.sha
            self.set_image(candidate, build=True)
            self.compose("build", self.service, timeout=1200, capture=False)
            image_id = self.image(candidate)
            self.record("dispatching", planningBackup=name, candidateImage=image_id)
            self.recreate()
            self.runner.run(["bash", str(self.checkout / "scripts/verify-control-center-loopback.sh")],
                            cwd=self.compose_dir, timeout=35, capture=False)
            self.verify(image_id)
            require(self.container().get("Config", {}).get("Labels", {}).get(
                "org.artem.source-revision") == self.sha, "runtime_revision_mismatch")
            return self.finish("deployed", image=image_id, planningBackup=name)
        except (DeploymentError, OSError, ValueError) as error:
            if isinstance(error, DeploymentError) and str(error) == "command_timeout":
                self.record("outcome_unknown")
                raise DeploymentError("deployment_outcome_unknown") from None
            return self.rollback_bot()

    def rollback_result(self) -> dict[str, Any]:
        if self.previous_revision is None:
            self.record("rollback_revision_unknown")
            return {"schemaVersion": 1, "target": self.target, "revision": None,
                    "attemptedRevision": self.sha, "status": "failed",
                    "error": "rollback_revision_unknown", "runtimeHealthy": True,
                    "image": self.previous_image}
        return self.finish("rolled_back", revision=self.previous_revision, image=self.previous_image)

    def rollback_bot(self) -> dict[str, Any]:
        self.record("rolling_back")
        try:
            self.git("checkout", "--detach", self.previous_head)
            self.set_image(self.previous_image, revision=self.previous_revision or self.previous_head)
            self.recreate()
            self.verify(self.previous_image, rollback=True)
            return self.rollback_result()
        except (DeploymentError, OSError):
            self.record("rollback_failed")
            raise DeploymentError("rollback_failed") from None

    def package_plan(self) -> dict[str, bytes]:
        mappings = self.config.get("managedFiles", [])
        require(isinstance(mappings, list) and len(mappings) <= 32, "invalid_packages")
        plan: dict[str, bytes] = {}
        for item in mappings:
            require(isinstance(item, dict) and set(item) == {"source", "destination"}, "invalid_packages")
            source, destination = relative_file(item["source"]), relative_file(item["destination"])
            prefix = "integration-patches/home-assistant/config/"
            component = destination.startswith("custom_components/artem_panel/")
            require(source.startswith(prefix) and self.managed_destination(destination) and
                    (source == prefix + destination if component else
                     source.startswith(prefix + "packages/") and source.endswith((".yaml", ".yml"))) and
                    destination not in plan,
                    "invalid_packages")
            plan[destination] = self.source(source)
        component_files = {path.split("/")[-1] for path in plan
                           if path.startswith("custom_components/artem_panel/")}
        require(not component_files or component_files == HA_COMPONENT_FILES,
                "incomplete_ha_component")
        return plan

    @staticmethod
    def managed_destination(path: str) -> bool:
        if path.startswith("packages/") and path.endswith((".yaml", ".yml")):
            return True
        prefix = "custom_components/artem_panel/"
        return path.startswith(prefix) and path[len(prefix):] in HA_COMPONENT_FILES

    def ha_image_reference(self) -> str | None:
        path = self.config.get("imageManifest")
        if path is None:
            return None
        data = json.loads(self.source(relative_file(path)))
        require(isinstance(data, dict) and set(data) == {"schemaVersion", "image"} and
                data["schemaVersion"] == 1 and isinstance(data["image"], str) and
                bool(HA_IMAGE.fullmatch(data["image"])), "unpinned_ha_image")
        return data["image"]

    def copy_config(self, source: Path, destination: Path, *, complete: bool) -> None:
        # Reject symlinks so private backups cannot silently omit an external DB
        # or traverse out of the explicitly reviewed /config bind mount.
        total_size = 0
        for directory, dirs, files in os.walk(source):
            dirs[:] = [name for name in dirs if name not in {"backups", ".git"}]
            for name in [*dirs, *files]:
                require(not (Path(directory) / name).is_symlink(), "ha_config_symlink")
            for name in files:
                info = (Path(directory) / name).stat()
                require(stat.S_ISREG(info.st_mode), "ha_config_special_file")
                total_size += info.st_size
        require(shutil.disk_usage(destination.parent).free >= total_size * 2 + 64 * 1024 * 1024,
                "insufficient_backup_space")
        def ignore(_directory, names):
            skip = {name for name in names if name in {"backups", ".git"}}
            if not complete:
                skip |= {name for name in names if name.startswith("home-assistant_v2.db") or
                         name.startswith("home-assistant.log")}
            return skip
        shutil.copytree(source, destination, ignore=ignore)
        os.chmod(destination, 0o700)

    def check_config(self, directory: Path, image: str) -> None:
        self.runner.run(["docker", "run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "python",
                         "--mount", "type=bind,source=" + str(directory) + ",target=/config",
                         image, "-m", "homeassistant", "--script", "check_config", "--config", "/config"],
                        timeout=180, capture=False)

    def deploy_ha(self, before: dict[str, Any]) -> dict[str, Any]:
        config_dir = Path(self.config["configDir"])
        require(config_dir.is_absolute() and config_dir.is_dir() and not config_dir.is_symlink(),
                "invalid_ha_config_dir")
        require(config_dir.resolve() not in self.state.resolve().parents and
                self.state.resolve() not in config_dir.resolve().parents, "overlapping_state")
        require(any(m.get("Destination") == "/config" and m.get("Type") == "bind" and
                    Path(m.get("Source", "")).resolve() == config_dir.resolve()
                    for m in before.get("Mounts", [])), "ha_config_mount_mismatch")
        plan = self.package_plan()
        reference = self.ha_image_reference()
        require(bool(plan) or reference is not None, "no_managed_ha_state")
        image_id = self.previous_image
        if reference:
            self.runner.run(["docker", "pull", reference], timeout=600, capture=False)
            image_id = self.image(reference)
        image_change = image_id != self.previous_image
        if image_change:
            require(self.config.get("allowImageChange") is True and
                    self.config.get("sqliteRecorderConfirmed") is True,
                    "ha_image_change_not_configured")
        changed = {path: data for path, data in plan.items()
                   if not contained_file(config_dir, path).exists() or
                   contained_file(config_dir, path).read_bytes() != data}
        fingerprints = {path: hashlib.sha256(data).hexdigest() for path, data in plan.items()}
        if not changed and not image_change:
            # Matching bytes do not prove HA loaded the package/component.
            self.verify(image_id)
            return self.finish("up_to_date", image=image_id, fileHashes=fingerprints)
        stage = self.transaction / "check-config"
        try:
            self.copy_config(config_dir, stage, complete=False)
            for path, data in plan.items():
                atomic_bytes(contained_file(stage, path), data, 0o600)
            self.check_config(stage, image_id)
        finally:
            # Syntax-validation copies may contain secrets; they are never
            # retained as diagnostics, including on failed validation.
            if stage.exists():
                shutil.rmtree(stage)
        backups: dict[str, dict[str, Any]] = {}
        for index, path in enumerate(changed):
            live = contained_file(config_dir, path)
            if live.exists():
                backup = self.transaction / "packages" / str(index)
                atomic_bytes(backup, live.read_bytes())
                backups[path] = {"file": str(backup), "mode": stat.S_IMODE(live.stat().st_mode)}
            else:
                backups[path] = {"file": None, "mode": 0o600}
        atomic_json(self.transaction / "package-backups.json", backups)
        self.record("prepared", imageChange=image_change, fileHashes=fingerprints)
        full_backup = self.transaction / "full-config"
        try:
            if image_change:
                self.record("stopping_for_backup", imageChange=True)
                self.runtime_touched = True
                self.compose("stop", self.service, timeout=120, capture=False)
                require(self.container().get("State", {}).get("Running") is False,
                        "ha_did_not_stop")
                self.copy_config(config_dir, full_backup, complete=True)
                atomic_json(self.transaction / "full-config-complete.json", {"complete": True})
            self.record("dispatching", imageChange=image_change, candidateImage=image_id)
            for path, data in changed.items():
                atomic_bytes(contained_file(config_dir, path), data, backups[path]["mode"])
            self.set_image(image_id)
            self.recreate()
            self.verify(image_id)
            require(all(contained_file(config_dir, path).read_bytes() == data
                        for path, data in plan.items()), "package_readback_mismatch")
            return self.finish("deployed", image=image_id, fileHashes=fingerprints)
        except (DeploymentError, OSError, ValueError) as error:
            if isinstance(error, DeploymentError) and str(error) == "command_timeout":
                self.record("outcome_unknown", imageChange=image_change)
                raise DeploymentError("deployment_outcome_unknown") from None
            return self.rollback_ha(config_dir, backups, full_backup)

    def rollback_ha(self, config_dir: Path, backups: dict[str, Any], full_backup: Path) -> dict[str, Any]:
        self.record("rolling_back")
        try:
            self.runtime_touched = True
            self.compose("stop", self.service, timeout=120, capture=False)
            if (self.transaction / "full-config-complete.json").exists():
                require(self.container().get("State", {}).get("Running") is False,
                        "ha_did_not_stop")
                # Keep failed candidate data for diagnosis. Never overlay a live DB.
                failed = config_dir.with_name(config_dir.name + ".failed-" + self.transaction.name)
                os.replace(config_dir, failed)
                os.chmod(failed, 0o700)
                self.copy_config(full_backup, config_dir, complete=True)
                for preserved in ("backups", ".git"):
                    if (failed / preserved).exists():
                        os.replace(failed / preserved, config_dir / preserved)
            else:
                for relative, info in backups.items():
                    destination = contained_file(config_dir, relative)
                    if info["file"] is None:
                        destination.unlink(missing_ok=True)
                    else:
                        atomic_bytes(destination, Path(info["file"]).read_bytes(), info["mode"])
            self.set_image(self.previous_image, revision=self.previous_revision or self.previous_head)
            self.recreate()
            self.verify(self.previous_image, rollback=True)
            return self.rollback_result()
        except (DeploymentError, OSError):
            self.record("rollback_failed")
            raise DeploymentError("rollback_failed") from None


def failure_result(target: str, sha: str, error: Exception,
                   deployment: Deployment | None) -> dict[str, Any]:
    code = str(error) if isinstance(error, DeploymentError) else "invalid_configuration_or_io"
    # Pure preflight failures may be re-evaluated. An existing journal (including
    # one from a crashed earlier process) always takes precedence over this flag.
    untouched = deployment is None or (not deployment.runtime_touched and not deployment.journal.exists())
    return {"schemaVersion": 1, "target": target, "revision": sha,
            "status": "deferred" if untouched else "failed", "error": code}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--target", choices=tuple(REPOSITORIES), required=True)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args(argv)
    deployment = None
    try:
        require(os.name == "posix", "linux_required")
        protected(args.config)
        config = read_json(args.config)
        state = Path(config["stateDir"])
        require(state.is_absolute(), "absolute_path_required")
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        protected(state)
        require(not stat.S_IMODE(state.stat().st_mode) & 0o077, "unprotected_state")
        # Use the same lock as the existing fixed home-maintenance helper.
        with deployment_lock(Path("/run/lock/artem-control-center-home-maintenance.lock")):
            deployment = Deployment(args.target, args.sha, config)
            result = deployment.run()
        print(json.dumps(result, sort_keys=True))
        return 0 if result["status"] in {"deployed", "up_to_date"} else 1
    except (DeploymentError, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps(failure_result(args.target, args.sha, exc, deployment)))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
