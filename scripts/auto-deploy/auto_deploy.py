"""Exact-main, green-CI deployment coordinator. Python standard library only.

GitHub webhooks are wake-up hints, never deployment authority. The same one-shot
reconciliation runs from a timer on Samsung, so no inbound home port is needed.
Local configuration is administrator-owned; no request chooses a command/path.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

SHA = re.compile(r"[0-9a-f]{40}\Z")
REPOS = {
    "panel": ("decorum-guy/artem-control-center", 1315596034),
    "home-assistant": ("decorum-guy/artem-control-center", 1315596034),
    "telegram-bot": ("decorum-guy/AliceTG_Bot", 1223671518),
}
SUCCESS = {"deployed", "up_to_date"}
KNOWN_FAILURE = {"rolled_back", "failed_healthy"}
MAX_BODY = 512 * 1024


class Blocked(Exception):
    """Only fixed, safe reason codes leave this module."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Blocked("github_redirect")


def require_sha(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise Blocked("invalid_revision")
    return value


def secret(path):
    with Path(path).open(encoding="utf-8") as stream:
        raw = stream.read(16385).strip()
    if not raw or len(raw) > 16384 or "\n" in raw or "\r" in raw:
        raise Blocked("invalid_secret_file")
    return raw


def load_config(path):
    try:
        config = json.loads(Path(path).read_text(encoding="utf-8"))
        if config.get("schemaVersion") != 1 or not isinstance(config.get("targets"), list):
            raise ValueError()
        if not Path(config["state_directory"]).is_absolute():
            raise ValueError()
        ids = set()
        for target in config["targets"]:
            if should_stop():
                break
            kind = target["id"]
            if kind not in REPOS or kind in ids:
                raise ValueError()
            ids.add(kind)
            repo, repository_id = REPOS[kind]
            if target["repository"] != repo or target["repository_id"] != repository_id:
                raise ValueError()
            if not isinstance(target.get("enabled"), bool):
                raise ValueError()
            policy = target["required_workflows"]
            if not isinstance(policy, dict) or not policy:
                raise ValueError()
            for workflow, jobs in policy.items():
                if not re.fullmatch(r"[A-Za-z0-9_-]+\.ya?ml", workflow):
                    raise ValueError()
                if not isinstance(jobs, list) or not jobs or len(set(jobs)) != len(jobs):
                    raise ValueError()
                if any(not isinstance(j, str) or not j or len(j) > 200 for j in jobs):
                    raise ValueError()
            if kind == "panel":
                if not Path(target["checkout"]).is_absolute() or not Path(target["adapter"]).is_absolute():
                    raise ValueError()
            else:
                if not Path(target["adapter"]).is_absolute() or not Path(target["adapter_config"]).is_absolute():
                    raise ValueError()
        secrets = config.get("webhook_secrets", {})
        if not isinstance(secrets, dict) or any(repo not in {r[0] for r in REPOS.values()} or not isinstance(path, str) or not Path(path).is_absolute() for repo, path in secrets.items()):
            raise ValueError()
        return config
    except (KeyError, ValueError, TypeError, OSError, json.JSONDecodeError):
        raise Blocked("invalid_config") from None


class GitHub:
    def __init__(self, token_file):
        self.token_file = token_file
        self.opener = build_opener(NoRedirect())

    def get(self, path):
        if not path.startswith("/repos/") or ".." in path or "\n" in path:
            raise Blocked("invalid_github_path")
        request = Request("https://api.github.com" + path, headers={
            "Authorization": "Bearer " + secret(self.token_file),
            "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Artem-Control-Center-Auto-Deploy/1",
        })
        try:
            with self.opener.open(request, timeout=15) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise Blocked("github_response_too_large")
                return json.loads(raw)
        except (URLError, OSError, ValueError):
            raise Blocked("github_unavailable") from None

    def main(self, target):
        base = "/repos/" + target["repository"]
        repo = self.get(base)
        if repo.get("id") != target["repository_id"] or repo.get("full_name") != target["repository"]:
            raise Blocked("repository_identity_mismatch")
        if repo.get("archived") or repo.get("disabled") or repo.get("default_branch") != "main":
            raise Blocked("repository_not_active_main")
        result = self.get(base + "/branches/main")
        return require_sha(result.get("commit", {}).get("sha"))

    def green(self, target, sha):
        """Require latest push run and every expected job, on the same exact SHA.

        No acceptance of pull_request/check-suite summaries, skipped jobs, an
        older successful attempt, or success inferred from a workflow name.
        """
        require_sha(sha)
        base = "/repos/" + target["repository"]
        evidence = []
        for workflow, expected_jobs in target["required_workflows"].items():
            query = urlencode({"branch": "main", "event": "push", "head_sha": sha, "per_page": 100})
            data = self.get(base + "/actions/workflows/" + quote(workflow, safe="") + "/runs?" + query)
            if not isinstance(data.get("workflow_runs"), list) or data.get("total_count", 0) > 100:
                raise Blocked("ci_response_incomplete")
            runs = [r for r in data["workflow_runs"] if (
                r.get("head_sha") == sha and r.get("head_branch") == "main" and r.get("event") == "push"
                and r.get("path") == ".github/workflows/" + workflow
                and r.get("repository", {}).get("id") == target["repository_id"]
                and r.get("head_repository", {}).get("id") == target["repository_id"]
            )]
            if not runs:
                raise Blocked("ci_missing")
            try:
                run = max(runs, key=lambda r: (int(r["run_number"]), int(r["run_attempt"]), int(r["id"])))
                run_id, attempt = int(run["id"]), int(run["run_attempt"])
                if run_id < 1 or attempt < 1:
                    raise ValueError()
            except (KeyError, ValueError, TypeError):
                raise Blocked("ci_response_invalid") from None
            if run.get("status") != "completed" or run.get("conclusion") != "success":
                raise Blocked("ci_not_green")
            jobs = []
            for page in range(1, 11):
                result = self.get(base + f"/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100&page={page}")
                batch = result.get("jobs")
                if not isinstance(batch, list) or not isinstance(result.get("total_count"), int):
                    raise Blocked("ci_jobs_invalid")
                jobs.extend(batch)
                if len(jobs) >= result["total_count"]:
                    break
            else:
                raise Blocked("ci_jobs_incomplete")
            names = [j.get("name") for j in jobs]
            if len(names) != len(set(names)) or not set(expected_jobs).issubset(names):
                raise Blocked("ci_jobs_missing")
            if any(j.get("head_sha") != sha or j.get("status") != "completed" or j.get("conclusion") != "success" for j in jobs):
                raise Blocked("ci_jobs_not_green")
            # A rerun can start while jobs are read. Re-read this attempt before
            # returning the receipt; the caller rechecks main before dispatch.
            current = self.get(base + f"/actions/runs/{run_id}")
            if (current.get("run_attempt") != attempt or current.get("status") != "completed"
                    or current.get("conclusion") != "success" or current.get("head_sha") != sha):
                raise Blocked("ci_changed_during_check")
            evidence.append({"workflow": workflow, "run_id": run_id, "attempt": attempt})
        # Revalidate all receipts together after the last workflow. A rerun
        # of an earlier workflow must not slip through while later jobs load.
        for item in evidence:
            query = urlencode({"branch": "main", "event": "push", "head_sha": sha, "per_page": 100})
            data = self.get(base + "/actions/workflows/" + quote(item["workflow"], safe="") + "/runs?" + query)
            if not isinstance(data.get("workflow_runs"), list) or data.get("total_count", 0) > 100:
                raise Blocked("ci_response_incomplete")
            runs = [r for r in data["workflow_runs"] if r.get("head_sha") == sha and r.get("head_branch") == "main" and r.get("event") == "push" and r.get("path") == ".github/workflows/" + item["workflow"]]
            try:
                latest = max(runs, key=lambda r: (int(r["run_number"]), int(r["run_attempt"]), int(r["id"])))
            except (ValueError, TypeError, KeyError):
                raise Blocked("ci_response_invalid") from None
            if (latest.get("id") != item["run_id"] or latest.get("run_attempt") != item["attempt"] or latest.get("status") != "completed" or latest.get("conclusion") != "success"):
                raise Blocked("ci_changed_during_check")
        return evidence


class State:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.directory / "state.sqlite3"
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, revision TEXT, status TEXT NOT NULL, reason TEXT, updated REAL NOT NULL, installed_revision TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS attempts (target TEXT, revision TEXT, status TEXT NOT NULL, updated REAL NOT NULL, PRIMARY KEY(target, revision))")
            db.execute("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, received REAL NOT NULL)")
        if os.name != "nt":
            self.path.chmod(0o600)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def get(self, target):
        with self.connect() as db:
            row = db.execute("SELECT * FROM targets WHERE id=?", (target,)).fetchone()
            return dict(row) if row else None

    def set(self, target, revision, status, reason="", installed=None):
        with self.connect() as db:
            old = db.execute("SELECT installed_revision FROM targets WHERE id=?", (target,)).fetchone()
            if installed is None and old:
                installed = old["installed_revision"]
            db.execute("INSERT OR REPLACE INTO targets VALUES (?, ?, ?, ?, ?, ?)", (target, revision, status, reason, time.time(), installed))

    def attempt(self, target, revision, status=None):
        with self.connect() as db:
            if status is not None:
                db.execute("INSERT OR REPLACE INTO attempts VALUES (?, ?, ?, ?)", (target, revision, status, time.time()))
            row = db.execute("SELECT status FROM attempts WHERE target=? AND revision=?", (target, revision)).fetchone()
            return row["status"] if row else None

    def transition(self, target, revision, outcome, status=None, reason="", installed=None):
        # Intent and host-visible status commit together. A crash between two
        # writes must never leave a dispatched attempt looking merely waiting.
        with self.connect() as db:
            old = db.execute("SELECT installed_revision FROM targets WHERE id=?", (target,)).fetchone()
            if installed is None and old:
                installed = old["installed_revision"]
            now = time.time()
            db.execute("INSERT OR REPLACE INTO attempts VALUES (?, ?, ?, ?)", (target, revision, outcome, now))
            db.execute("INSERT OR REPLACE INTO targets VALUES (?, ?, ?, ?, ?, ?)", (target, revision, status or outcome, reason, now, installed))

    def delivered(self, delivery):
        with self.connect() as db:
            # Retain one month; old replays still cannot authorise a revision.
            db.execute("DELETE FROM deliveries WHERE received < ?", (time.time() - 31 * 86400,))
            try:
                db.execute("INSERT INTO deliveries VALUES (?, ?)", (delivery, time.time()))
                return True
            except sqlite3.IntegrityError:
                return False

    def status(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM targets ORDER BY id")]


@contextlib.contextmanager
def host_lock(directory):
    """Kernel-held host-wide lock: released on process death, never stolen by age."""
    path = Path(directory) / "worker.lock"
    with path.open("a+b") as file:
        if file.tell() == 0:
            file.write(b"\0")
            file.flush()
        file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise Blocked("worker_busy") from None
        try:
            yield
        finally:
            if os.name == "nt":
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(file.fileno(), fcntl.LOCK_UN)


def execute_adapter(target, sha, directory):
    """Only fixed adapter types and locally installed paths, never webhook argv."""
    require_sha(sha)
    if target["id"] == "panel":
        if os.name != "nt":
            return {"status": "failed_healthy", "revision": None, "reason": "windows_required"}
        script = Path(target["adapter"])
        command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), "-RepoRoot", target["checkout"], "-ExpectedTargetHead", sha]
    else:
        command = [sys.executable, target["adapter"], "--config", target["adapter_config"], "--target", target["id"], "--sha", sha]
    output = Path(directory) / (target["id"] + "-adapter-result.json")
    try:
        with output.open("wb") as stream:
            if os.name != "nt":
                output.chmod(0o600)
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.DEVNULL)
            try:
                returncode = process.wait(timeout=35 * 60)
            except subprocess.TimeoutExpired:
                # Do not terminate a potentially mutating child, do not retry.
                return {"status": "uncertain", "reason": "adapter_timeout"}
        raw = output.read_bytes()
        if len(raw) > 65536:
            raise ValueError()
        result = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(result, dict) or result.get("status") not in SUCCESS | KNOWN_FAILURE | {"failed", "uncertain", "deferred"}:
            raise ValueError()
        if result["status"] in SUCCESS and (returncode != 0 or result.get("revision") != sha):
            raise ValueError()
        if result.get("revision") is not None:
            require_sha(result["revision"])
        # Strip any adapter-specific strings and fields from public status.
        return {"status": result["status"], "revision": result.get("revision")}
    except OSError:
        return {"status": "uncertain", "reason": "adapter_start_or_io_failed"}
    except (ValueError, Blocked):
        return {"status": "uncertain", "reason": "adapter_result_invalid"}


def reconcile(config, state, github, adapter=execute_adapter, should_stop=None):
    """One finite pass. Network/gate failures retry; dispatched failures do not."""
    should_stop = should_stop or (lambda: False)
    with host_lock(state.directory):
        # A timed-out child may still be changing the host. Freeze all targets,
        # including when the original target is disabled/removed from config.
        pending = [row for row in state.status() if row["status"] in {"deploying", "uncertain"}]
        if pending:
            for row in pending:
                state.set(row["id"], row["revision"], "uncertain", "operator_recovery_required")
            return state.status()
        for target in config["targets"]:
            kind = target["id"]
            previous = state.get(kind)
            if not target["enabled"]:
                # Disabling/re-enabling must not erase an uncertain attempt.
                if previous is None:
                    state.set(kind, None, "disabled")
                continue
            if previous and previous["status"] in {"deploying", "uncertain"}:
                state.set(kind, previous["revision"], "uncertain", "operator_recovery_required")
                continue
            sha = None
            try:
                sha = github.main(target)
                if state.attempt(kind, sha) in SUCCESS:
                    state.set(kind, sha, "last_verified")
                    continue
                if state.attempt(kind, sha) in KNOWN_FAILURE | {"failed", "uncertain", "deploying"}:
                    state.set(kind, sha, "blocked", "revision_already_attempted")
                    continue
                github.green(target, sha)
                # Exact-main race check immediately before writing durable intent.
                if github.main(target) != sha:
                    raise Blocked("main_changed_during_check")
                if should_stop():
                    break
                state.transition(kind, sha, "deploying")
                result = adapter(target, sha, state.directory)
                outcome = result.get("status")
                if outcome == "deferred":
                    state.transition(kind, sha, "deferred", "waiting", "host_temporarily_busy_or_stopped")
                    break
                if outcome not in SUCCESS | KNOWN_FAILURE or not isinstance(result.get("revision"), str) or not SHA.fullmatch(result["revision"]) or (outcome in SUCCESS and result.get("revision") != sha):
                    outcome = "uncertain"
                state.transition(kind, sha, outcome, reason="" if outcome in SUCCESS else "deployment_not_completed", installed=result.get("revision") if outcome != "uncertain" else None)
                if outcome == "uncertain":
                    break
            except Blocked as exc:
                if sha and state.attempt(kind, sha) == "deploying":
                    state.transition(kind, sha, "uncertain", reason="operator_recovery_required")
                    break
                else:
                    state.set(kind, sha, "waiting", str(exc))
            except Exception:
                # A thrown adapter exception may follow a mutation. Never turn
                # this into a network retry or echo exception/secret contents.
                if sha and state.attempt(kind, sha) == "deploying":
                    state.transition(kind, sha, "uncertain", reason="operator_recovery_required")
                    break
                else:
                    state.set(kind, sha, "waiting", "verification_unavailable")
    return state.status()


def accept_webhook(headers, body, config, state):
    if len(body) > MAX_BODY:
        raise Blocked("payload_too_large")
    try:
        data = json.loads(body)
        repository = data["repository"]["full_name"]
        secret_file = config["webhook_secrets"][repository]
    except (ValueError, TypeError, KeyError):
        raise Blocked("repository_not_allowed") from None
    signature = headers.get("X-Hub-Signature-256", "")
    expected = "sha256=" + hmac.new(secret(secret_file).encode(), body, hashlib.sha256).hexdigest()
    if not re.fullmatch(r"sha256=[0-9a-f]{64}", signature) or not hmac.compare_digest(signature, expected):
        raise Blocked("invalid_signature")
    delivery = headers.get("X-GitHub-Delivery", "")
    if not re.fullmatch(r"[A-Za-z0-9-]{8,128}", delivery):
        raise Blocked("invalid_delivery")
    try:
        repo = data["repository"]
        targets = [t for t in config["targets"] if t["repository"] == repo["full_name"] and t["repository_id"] == repo["id"]]
        if not targets:
            raise Blocked("repository_not_allowed")
        event = headers.get("X-GitHub-Event")
        if event == "push":
            if data.get("ref") != "refs/heads/main" or data.get("deleted"):
                raise Blocked("event_not_main")
            require_sha(data.get("after"))
        elif event == "workflow_run":
            run = data.get("workflow_run", {})
            if data.get("action") != "completed" or run.get("head_branch") != "main" or run.get("event") != "push":
                raise Blocked("event_not_main")
            require_sha(run.get("head_sha"))
        elif event != "ping":
            raise Blocked("event_not_allowed")
    except (TypeError, ValueError, KeyError):
        raise Blocked("payload_invalid") from None
    # No SHA/commands stored from the payload. Reconcile asks GitHub for main.
    return state.delivered(delivery)


def worker_loop(config, state, github, wake, stop):
    while not stop.is_set():
        try:
            reconcile(config, state, github, should_stop=stop.is_set)
        except Exception:
            # Storage/host errors must not silently kill reconciliation while
            # the listener continues acknowledging webhooks. Persisted intent
            # remains host-blocking when the next pass can read it.
            pass
        wake.wait(60)
        wake.clear()


def serve(config, state, github):
    wake = threading.Event()
    stop = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            if self.path != "/hooks/github":
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_BODY or self.headers.get("Transfer-Encoding"):
                    raise Blocked("payload_size")
                self.connection.settimeout(5)
                body = self.rfile.read(length)
                if len(body) != length:
                    raise Blocked("payload_size")
                fresh = accept_webhook(self.headers, body, config, state)
                if fresh:
                    wake.set()
                self.send_response(202)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"accepted":true}')
            except (Blocked, OSError, ValueError):
                self.send_error(403, "Rejected")

    # Reverse proxy may expose only this path with TLS, body limit and rate limit.
    # Never bind the daemon itself publicly; never expose Panel Agent here.
    port = config.get("webhook_port", 18765)
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise Blocked("invalid_webhook_port")
    class BoundedHTTPServer(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(5)
            return connection, address

    server = BoundedHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=worker_loop, args=(config, state, github, wake, stop), daemon=True)
    thread.start()
    previous_signals = {}
    def request_stop(_number, _frame):
        stop.set()
        wake.set()
        # shutdown must run outside serve_forever's own thread.
        threading.Thread(target=server.shutdown, daemon=True).start()
    if threading.current_thread() is threading.main_thread():
        for number in (signal.SIGTERM, signal.SIGINT):
            previous_signals[number] = signal.signal(number, request_stop)
    try:
        server.serve_forever()
    finally:
        for number, previous in previous_signals.items():
            signal.signal(number, previous)
        stop.set()
        wake.set()
        server.server_close()
        # Do not interrupt an in-flight deployment on service shutdown. A host
        # interruption persists deploying; next start requires recovery.
        thread.join()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["reconcile", "serve", "status", "reset"])
    parser.add_argument("--config", required=True)
    parser.add_argument("--target", choices=list(REPOS))
    parser.add_argument("--sha")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        state = State(config["state_directory"])
        if args.command == "status":
            result = state.status()
        elif args.command == "reset":
            # Explicit operator command after inspecting runtime/rollback. Never
            # callable over HTTP. It does not deploy; next pass still checks CI.
            if args.target not in {t["id"] for t in config["targets"]}:
                raise Blocked("invalid_reset_target")
            sha = require_sha(args.sha)
            with host_lock(state.directory):
                previous = state.get(args.target)
                if not previous or previous["revision"] != sha:
                    raise Blocked("reset_revision_mismatch")
                state.transition(args.target, sha, "reset", "waiting", "operator_reset")
            result = state.status()
        else:
            github = GitHub(config["github_token_file"])
            if args.command == "serve":
                serve(config, state, github)
                return 0
            result = reconcile(config, state, github)
        print(json.dumps({"schemaVersion": 1, "targets": result}, separators=(",", ":")))
        return 0
    except Blocked as exc:
        print(json.dumps({"schemaVersion": 1, "error": str(exc)}))
        return 2
    except Exception:
        print('{"schemaVersion":1,"error":"coordinator_unavailable"}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
