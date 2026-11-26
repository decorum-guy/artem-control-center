"""Synthetic GitHub/adapter tests. No live GitHub writes or device commands."""
import copy
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import threading
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "auto_deploy.py"
spec = importlib.util.spec_from_file_location("auto_deploy", MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SHA = "a" * 40
NEXT = "b" * 40
REPO = "decorum-guy/artem-control-center"
RID = 1315596034
TARGET = {"id": "panel", "enabled": True, "repository": REPO, "repository_id": RID,
          "required_workflows": {"ci.yml": ["Linux", "Windows"]}}


class API(m.GitHub):
    def __init__(self):
        self.calls = []
        self.run = {"id": 12, "run_number": 7, "run_attempt": 2, "event": "push", "path": ".github/workflows/ci.yml",
                    "head_branch": "main", "head_sha": SHA, "status": "completed", "conclusion": "success",
                    "repository": {"id": RID}, "head_repository": {"id": RID}}
        self.runs = [self.run]
        self.jobs = [{"name": name, "status": "completed", "conclusion": "success", "head_sha": SHA} for name in ("Linux", "Windows")]
        self.main_sha = SHA
        self.repo_id = RID
        self.current = None
        self.job_pages = None

    def get(self, path):
        self.calls.append(path)
        if path.endswith("/branches/main"):
            return {"commit": {"sha": self.main_sha}}
        if "/workflows/" in path:
            return {"total_count": len(self.runs), "workflow_runs": copy.deepcopy(self.runs)}
        if "/jobs?" in path:
            if self.job_pages:
                return self.job_pages[int(path.rsplit("=", 1)[1]) - 1]
            return {"total_count": len(self.jobs), "jobs": copy.deepcopy(self.jobs)}
        if "/actions/runs/" in path:
            return copy.deepcopy(self.current or self.run)
        return {"id": self.repo_id, "full_name": REPO, "default_branch": "main", "archived": False, "disabled": False}


class GateTests(unittest.TestCase):
    def setUp(self):
        self.api = API()

    def test_exact_main_green_job_receipt(self):
        self.assertEqual(self.api.main(TARGET), SHA)
        self.assertEqual(self.api.green(TARGET, SHA), [{"workflow": "ci.yml", "run_id": 12, "attempt": 2}])
        self.assertTrue(any("attempts/2/jobs" in c for c in self.api.calls))

    def test_repository_numeric_identity_pinned(self):
        self.api.repo_id = 2
        with self.assertRaisesRegex(m.Blocked, "identity_mismatch"):
            self.api.main(TARGET)

    def test_pr_branch_and_other_sha_success_never_count(self):
        for key, value in [("event", "pull_request"), ("head_branch", "main-other"), ("head_sha", NEXT), ("path", ".github/workflows/fake.yml")]:
            with self.subTest(key=key):
                api = API()
                api.run[key] = value
                with self.assertRaisesRegex(m.Blocked, "ci_missing"):
                    api.green(TARGET, SHA)

    def test_newer_failure_beats_old_green(self):
        newest = dict(self.api.run, id=13, run_number=8, conclusion="failure")
        self.api.runs.append(newest)
        with self.assertRaisesRegex(m.Blocked, "ci_not_green"):
            self.api.green(TARGET, SHA)

    def test_newer_queued_attempt_beats_old_green(self):
        self.api.runs.append(dict(self.api.run, run_attempt=3, status="queued", conclusion=None))
        with self.assertRaisesRegex(m.Blocked, "ci_not_green"):
            self.api.green(TARGET, SHA)

    def test_missing_skipped_wrong_sha_and_duplicate_jobs_fail_closed(self):
        for jobs, reason in [
            (self.api.jobs[:1], "ci_jobs_missing"),
            ([self.api.jobs[0], dict(self.api.jobs[1], conclusion="skipped")], "ci_jobs_not_green"),
            ([self.api.jobs[0], dict(self.api.jobs[1], head_sha=NEXT)], "ci_jobs_not_green"),
            (self.api.jobs + [self.api.jobs[0]], "ci_jobs_missing"),
        ]:
            with self.subTest(reason=reason):
                api = API()
                api.jobs = jobs
                with self.assertRaisesRegex(m.Blocked, reason):
                    api.green(TARGET, SHA)

    def test_all_jobs_must_pass_even_if_not_in_required_names(self):
        self.api.jobs.append({"name": "New security gate", "status": "completed", "conclusion": "failure", "head_sha": SHA})
        with self.assertRaisesRegex(m.Blocked, "ci_jobs_not_green"):
            self.api.green(TARGET, SHA)

    def test_newer_run_started_after_receipt_check_blocks_final_validation(self):
        original = self.api.get
        calls = 0
        def get(path):
            nonlocal calls
            if "/workflows/" in path:
                calls += 1
                if calls == 2:
                    self.api.runs.append(dict(self.api.run, id=13, run_number=8, status="queued", conclusion=None))
            return original(path)
        self.api.get = get
        with self.assertRaisesRegex(m.Blocked, "ci_changed"):
            self.api.green(TARGET, SHA)

    def test_jobs_follow_pagination(self):
        self.api.job_pages = [{"total_count": 2, "jobs": self.api.jobs[:1]}, {"total_count": 2, "jobs": self.api.jobs[1:]}]
        self.api.green(TARGET, SHA)
        self.assertTrue(any("page=2" in c for c in self.api.calls))

    def test_rerun_started_while_reading_jobs_blocks(self):
        self.api.current = dict(self.api.run, run_attempt=3, status="in_progress", conclusion=None)
        with self.assertRaisesRegex(m.Blocked, "ci_changed"):
            self.api.green(TARGET, SHA)


class StubGitHub:
    def __init__(self):
        self.sha = SHA
        self.head_calls = 0
        self.gate_error = None
        self.change_before_dispatch = False
        self.gate_calls = 0

    def main(self, target):
        self.head_calls += 1
        if self.change_before_dispatch and self.head_calls > 1:
            return NEXT
        return self.sha

    def green(self, target, sha):
        self.gate_calls += 1
        if self.gate_error:
            raise m.Blocked(self.gate_error)
        return []


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = m.State(self.temp.name)
        self.config = {"targets": [copy.deepcopy(TARGET)]}
        self.github = StubGitHub()
        self.dispatches = []
        self.outcome = {"status": "deployed", "revision": SHA}

    def adapter(self, target, sha, directory):
        self.dispatches.append((target["id"], sha))
        return self.outcome

    def run_pass(self):
        return m.reconcile(self.config, self.state, self.github, self.adapter)

    def test_disabled_never_reads_or_dispatches(self):
        self.config["targets"][0]["enabled"] = False
        self.run_pass()
        self.assertEqual(self.github.head_calls, 0)
        self.assertEqual(self.dispatches, [])

    def test_success_persists_installed_revision_and_dedupes_restart(self):
        self.run_pass()
        again = m.State(self.temp.name)
        m.reconcile(self.config, again, self.github, self.adapter)
        self.assertEqual(self.dispatches, [("panel", SHA)])
        self.assertEqual(again.get("panel")["status"], "last_verified")
        self.assertEqual(again.get("panel")["installed_revision"], SHA)

    def test_network_or_ci_wait_retries_before_dispatch(self):
        self.github.gate_error = "github_unavailable"
        self.run_pass()
        self.assertEqual(self.dispatches, [])
        self.github.gate_error = None
        self.run_pass()
        self.assertEqual(len(self.dispatches), 1)

    def test_main_change_during_ci_never_dispatches(self):
        self.github.change_before_dispatch = True
        self.run_pass()
        self.assertEqual(self.dispatches, [])
        self.assertEqual(self.state.get("panel")["reason"], "main_changed_during_check")

    def test_failed_sha_is_not_retried_new_sha_can_after_healthy_rollback(self):
        old = "c" * 40
        self.outcome = {"status": "rolled_back", "revision": old}
        self.run_pass()
        self.run_pass()
        self.assertEqual(len(self.dispatches), 1)
        self.assertEqual(self.state.get("panel")["installed_revision"], old)
        self.github.sha = NEXT
        self.outcome = {"status": "deployed", "revision": NEXT}
        self.run_pass()
        self.assertEqual(len(self.dispatches), 2)

    def test_uncertain_blocks_even_new_head_and_survives_restart(self):
        self.outcome = {"status": "uncertain"}
        self.run_pass()
        self.github.sha = NEXT
        self.state = m.State(self.temp.name)
        self.run_pass()
        self.assertEqual(len(self.dispatches), 1)
        self.assertEqual(self.state.get("panel")["status"], "uncertain")

    def test_process_death_after_durable_intent_never_replays(self):
        self.state.attempt("panel", SHA, "deploying")
        self.state.set("panel", SHA, "deploying")
        self.run_pass()
        self.assertEqual(self.dispatches, [])
        self.assertEqual(self.state.get("panel")["reason"], "operator_recovery_required")

    def test_adapter_exception_is_uncertain_not_retryable(self):
        for exception in [RuntimeError("secret fake token"), m.Blocked("fake")]:
            with self.subTest(exception=type(exception).__name__):
                self.state.set("panel", SHA, "waiting")
                self.state.attempt("panel", SHA, "reset")
                def broken(*args):
                    raise exception
                m.reconcile(self.config, self.state, self.github, broken)
                self.assertEqual(self.state.get("panel")["status"], "uncertain")
                self.assertNotIn("secret", json.dumps(self.state.status()))

    def test_adapter_false_success_with_wrong_revision_blocks(self):
        self.outcome = {"status": "deployed", "revision": NEXT}
        self.run_pass()
        self.assertEqual(self.state.get("panel")["status"], "uncertain")
        self.assertIsNone(self.state.get("panel")["installed_revision"])

    def test_host_lock_excludes_second_worker(self):
        with m.host_lock(self.temp.name):
            with self.assertRaisesRegex(m.Blocked, "worker_busy"):
                self.run_pass()
        self.assertEqual(self.dispatches, [])
        self.run_pass()
        self.assertEqual(len(self.dispatches), 1)

    def test_uncertain_first_target_freezes_whole_host_even_when_disabled(self):
        second = copy.deepcopy(TARGET)
        second["id"] = "home-assistant"
        self.config["targets"].append(second)
        self.outcome = {"status": "uncertain"}
        self.run_pass()
        self.assertEqual(self.dispatches, [("panel", SHA)])
        self.config["targets"][0]["enabled"] = False
        self.github.sha = NEXT
        self.run_pass()
        self.assertEqual(self.dispatches, [("panel", SHA)])
        self.assertEqual(self.state.get("panel")["status"], "uncertain")
        self.assertIsNone(self.state.get("home-assistant"))

    def test_disabled_or_removed_target_cannot_clear_inflight_host_block(self):
        self.state.set("panel", SHA, "deploying")
        self.config["targets"] = [dict(TARGET, id="home-assistant")]
        self.run_pass()
        self.assertEqual(self.dispatches, [])
        self.assertEqual(self.state.get("panel")["status"], "uncertain")

    def test_preflight_deferred_can_retry_but_does_not_dispatch_next_target(self):
        self.config["targets"].append(dict(TARGET, id="home-assistant"))
        self.outcome = {"status": "deferred"}
        self.run_pass()
        self.assertEqual(self.dispatches, [("panel", SHA)])
        self.config["targets"] = self.config["targets"][:1]
        self.outcome = {"status": "deployed", "revision": SHA}
        self.run_pass()
        self.assertEqual(self.dispatches, [("panel", SHA), ("panel", SHA)])

    def test_shutdown_finishes_inflight_but_does_not_start_next_target(self):
        self.config["targets"].append(dict(TARGET, id="home-assistant"))
        stop = threading.Event()
        def adapter(target, sha, directory):
            self.dispatches.append((target["id"], sha))
            stop.set()
            return {"status": "deployed", "revision": sha}
        m.reconcile(self.config, self.state, self.github, adapter, should_stop=stop.is_set)
        self.assertEqual(self.dispatches, [("panel", SHA)])
        self.assertEqual(self.state.get("panel")["status"], "deployed")
        self.assertIsNone(self.state.get("home-assistant"))

    def test_shutdown_during_ci_check_never_dispatches(self):
        stop = threading.Event()
        original = self.github.green
        def green(target, sha):
            result = original(target, sha)
            stop.set()
            return result
        self.github.green = green
        m.reconcile(self.config, self.state, self.github, self.adapter, should_stop=stop.is_set)
        self.assertEqual(self.dispatches, [])
        self.assertIsNone(self.state.attempt("panel", SHA))

    def test_new_push_during_dispatch_does_not_cancel_inflight(self):
        def adapter(target, sha, directory):
            self.github.sha = NEXT
            return {"status": "deployed", "revision": sha}
        m.reconcile(self.config, self.state, self.github, adapter)
        self.assertEqual(self.state.get("panel")["installed_revision"], SHA)
        self.outcome = {"status": "deployed", "revision": NEXT}
        self.run_pass()
        self.assertEqual(self.state.get("panel")["installed_revision"], NEXT)


class WorkerLoopTests(unittest.TestCase):
    def test_unexpected_storage_error_does_not_kill_later_reconciliation(self):
        stop = threading.Event()
        class Wake:
            waits = 0
            def wait(self, seconds):
                self.waits += 1
                if self.waits >= 2:
                    stop.set()
            def clear(self):
                pass
        wake = Wake()
        with patch.object(m, "reconcile", side_effect=[RuntimeError("sqlite unavailable"), []]) as reconcile:
            m.worker_loop({}, None, None, wake, stop)
        self.assertEqual(reconcile.call_count, 2)
        self.assertEqual(wake.waits, 2)


class WebhookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = m.State(self.temp.name)
        key = Path(self.temp.name) / "key"
        key.write_text("test-hmac-secret")
        self.config = {"targets": [TARGET], "webhook_secrets": {REPO: str(key)}}
        self.payload = {"repository": {"id": RID, "full_name": REPO}, "ref": "refs/heads/main", "after": SHA}

    def call(self, payload=None, delivery="event-123456", event="push", bad_signature=False):
        body = json.dumps(payload or self.payload).encode()
        signature = hmac.new(b"test-hmac-secret", body, hashlib.sha256).hexdigest()
        headers = {"X-Hub-Signature-256": "sha256=" + ("0" * 64 if bad_signature else signature),
                   "X-GitHub-Delivery": delivery, "X-GitHub-Event": event}
        return m.accept_webhook(headers, body, self.config, self.state)

    def test_signed_hint_deduped_durably(self):
        self.assertTrue(self.call())
        self.state = m.State(self.temp.name)
        self.assertFalse(self.call())
        # The event SHA is not stored as deploy authority.
        self.assertEqual(self.state.status(), [])

    def test_tampered_signature_unknown_repository_and_branch_rejected(self):
        with self.assertRaisesRegex(m.Blocked, "signature"):
            self.call(bad_signature=True)
        for changes in [{"ref": "refs/heads/topic"}, {"repository": {"id": 4, "full_name": REPO}}, {"deleted": True}]:
            with self.subTest(changes=changes):
                with self.assertRaises(m.Blocked):
                    self.call(dict(self.payload, **changes))

    def test_workflow_completion_only_for_push_main(self):
        payload = {"repository": self.payload["repository"], "action": "completed", "workflow_run": {"event": "push", "head_branch": "main", "head_sha": SHA}}
        self.assertTrue(self.call(payload, event="workflow_run"))
        payload["workflow_run"]["event"] = "pull_request"
        with self.assertRaises(m.Blocked):
            self.call(payload, event="workflow_run")

    def test_old_signed_event_is_only_wakeup_not_old_revision_authority(self):
        payload = dict(self.payload, after="c" * 40)
        self.assertTrue(self.call(payload))
        github = StubGitHub()
        dispatched = []
        m.reconcile(self.config, self.state, github, lambda t, s, d: dispatched.append(s) or {"status": "deployed", "revision": s})
        self.assertEqual(dispatched, [SHA])

    def test_invalid_events_and_size(self):
        with self.assertRaisesRegex(m.Blocked, "event_not_allowed"):
            self.call(event="issue_comment")
        with self.assertRaisesRegex(m.Blocked, "payload_too_large"):
            m.accept_webhook({}, b"x" * (m.MAX_BODY + 1), self.config, self.state)


if __name__ == "__main__":
    unittest.main()
