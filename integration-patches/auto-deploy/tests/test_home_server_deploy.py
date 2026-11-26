"""Controlled subprocess/HTTP responses; these tests never contact a host."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "deploy_home_server.py"
spec = importlib.util.spec_from_file_location("home_server_deploy", MODULE)
deploy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = deploy
spec.loader.exec_module(deploy)

OLD = "1" * 40
NEW = "2" * 40
OLD_IMAGE = "sha256:" + "a" * 64
NEW_IMAGE = "sha256:" + "b" * 64
PIN = "ghcr.io/home-assistant/home-assistant@sha256:" + "c" * 64
SOURCE = "integration-patches/home-assistant/config/packages/panel_brightness.yaml"
PACKAGE = "packages/panel_brightness.yaml"
BACKUP = "planning-20261127T020000Z-schema5-123456abcdef.sqlite3.a8"


class FakeHealth:
    def __init__(self):
        self.calls = []
        self.fail_wait = 0
        self.fail_check = False

    def check(self, **kwargs):
        self.calls.append(("check", kwargs))
        if self.fail_check:
            raise deploy.DeploymentError("health_not_ready")

    def wait(self, **kwargs):
        self.calls.append(("wait", kwargs))
        if self.fail_wait:
            self.fail_wait -= 1
            raise deploy.DeploymentError("health_timeout")


class FakeRunner:
    def __init__(self, root, target, state):
        self.root, self.target, self.state = root, target, state
        self.calls = []
        self.head = OLD
        self.main = NEW
        self.origin = "https://github.com/" + deploy.REPOSITORIES[target] + ".git"
        self.dirty = ""
        self.migrations = ""
        self.active_image = OLD_IMAGE
        self.running = True
        self.labels = {"org.artem.source-revision": OLD}
        self.sources = {SOURCE: "template:\n  - sensor: []\n\n", "deploy/ha-image.json": json.dumps({"schemaVersion": 1, "image": PIN})}
        self.mode = "100644"
        self.fail_syntax = False
        self.fail_recreate = 0
        self.timeout_recreate = False
        self.recreate_hook = None
        self.verified_backup = True

    def run(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if argv[0] == "git":
            args = argv[3:]
            if args[:2] == ["rev-parse", "--show-toplevel"]:
                return str(self.root / "checkout")
            if args[:2] == ["remote", "get-url"]:
                return self.origin
            if args[0] == "status":
                return self.dirty
            if args == ["rev-parse", "HEAD"]:
                return self.head
            if args == ["rev-parse", "refs/remotes/origin/main"]:
                return self.main
            if args[0] == "fetch":
                return ""
            if args[0] == "diff":
                return self.migrations
            if args[0] == "ls-tree":
                if "-r" in args:
                    return "100644 blob " + "e" * 40 + "\tapp/main.py\n100644 blob " + "f" * 40 + "\trequirements.txt"
                return self.mode + " blob " + "f" * 40 + "\t" + args[-1]
            if args[0] == "show":
                value = self.sources[args[-1].split(":", 1)[1]]
                return value.strip() if kwargs.get("strip_output", True) else value
            if args[:2] == ["checkout", "--detach"]:
                self.head = args[-1]
                return ""
        if argv[:2] == ["docker", "compose"]:
            if "ps" in argv:
                return "d" * 64
            if "exec" in argv:
                if "-c" in argv:
                    return json.dumps({"app/main.py": "e" * 40, "requirements.txt": "f" * 40})
                if argv[-1] == "backup":
                    return json.dumps({"ok": True, "package": BACKUP})
                return json.dumps({"ok": self.verified_backup})
            if "build" in argv:
                return ""
            if "stop" in argv:
                self.running = False
                return ""
            if "up" in argv:
                if self.timeout_recreate:
                    raise deploy.DeploymentError("command_timeout")
                if self.fail_recreate:
                    self.fail_recreate -= 1
                    raise deploy.DeploymentError("command_failed")
                overlay = json.loads((self.state / self.target / "active-image.json").read_text())
                value = overlay["services"][self.target.replace("home-assistant", "homeassistant")]
                self.active_image = NEW_IMAGE if value["image"].startswith("artem-auto/") else value["image"]
                self.labels = value["labels"]
                self.running = True
                if self.recreate_hook:
                    self.recreate_hook()
                return ""
        if argv[:2] == ["docker", "inspect"]:
            return json.dumps([{"Image": self.active_image, "State": {"Running": self.running},
                                "Config": {"Labels": self.labels},
                                "Mounts": [{"Type": "bind", "Source": str(self.root / "ha-config"), "Destination": "/config"}]}])
        if argv[:3] == ["docker", "image", "inspect"]:
            return NEW_IMAGE
        if argv[:2] == ["docker", "pull"]:
            return ""
        if argv[:2] == ["docker", "run"]:
            if self.fail_syntax:
                raise deploy.DeploymentError("command_failed")
            return ""
        if argv[0] == "bash":
            return ""
        raise AssertionError(argv)


@unittest.skipUnless(os.name == "posix", "Linux VPS adapter: POSIX permissions and Docker host")
class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ("checkout", "state", "compose", "ha-config/packages"):
            (self.root / name).mkdir(parents=True)
        (self.root / "ha-config/configuration.yaml").write_text("homeassistant:\n  packages: !include_dir_named packages\n")
        (self.root / "ha-config" / PACKAGE).write_text("old: true\n")

    def make(self, target="telegram-bot"):
        cfg = {"schemaVersion": 1, "stateDir": str(self.root / "state"), "targets": {
            target: {"enabled": True, "repository": deploy.REPOSITORIES[target],
                     "checkout": str(self.root / "checkout"), "composeProjectDir": str(self.root / "compose"),
                     "composeFile": str(self.root / "compose/compose.yml"),
                     "loopbackOverlay": str(self.root / "compose/loopback.yml"),
                     "service": target.replace("home-assistant", "homeassistant"),
                     "apiUrl": "http://127.0.0.1:18123", "configDir": str(self.root / "ha-config"),
                     "managedFiles": [{"source": SOURCE, "destination": PACKAGE}],
                     "imageManifest": None, "allowImageChange": False, "sqliteRecorderConfirmed": False}}}
        runner = FakeRunner(self.root, target, self.root / "state")
        health = FakeHealth()
        value = deploy.Deployment(target, NEW, cfg, runner=runner, health=health)
        if target == "home-assistant":
            deploy.atomic_json(value.marker, {"revision": OLD, "image": OLD_IMAGE,
                "fileHashes": {PACKAGE: deploy.hashlib.sha256((self.root / "ha-config" / PACKAGE).read_bytes()).hexdigest()}})
        return value, runner, health

    def assert_no_dispatch(self, runner):
        self.assertFalse(any("up" in args or "stop" in args or "checkout" in args for args, _ in runner.calls))

    def test_wrong_origin_blocks_before_mutation(self):
        value, runner, _ = self.make()
        runner.origin = "https://example.invalid/attacker.git"
        with self.assertRaisesRegex(deploy.DeploymentError, "wrong_origin"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_latest_main_moved_blocks_even_valid_older_sha(self):
        value, runner, _ = self.make()
        runner.main = "3" * 40
        with self.assertRaisesRegex(deploy.DeploymentError, "main_moved"):
            value.run()
        self.assert_no_dispatch(runner)
        self.assertEqual(deploy.failure_result(value.target, NEW,
            deploy.DeploymentError("main_moved"), value)["status"], "deferred")

    def test_dirty_checkout_preserves_changes(self):
        value, runner, _ = self.make()
        runner.dirty = " M configuration.yml"
        with self.assertRaisesRegex(deploy.DeploymentError, "dirty_checkout"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_pending_crash_journal_blocks_automatic_retry(self):
        value, runner, _ = self.make()
        deploy.atomic_json(value.journal, {"phase": "dispatching"})
        with self.assertRaisesRegex(deploy.DeploymentError, "previous_attempt_unresolved"):
            value.run()
        self.assertEqual(runner.calls, [])
        self.assertEqual(deploy.failure_result(value.target, NEW,
            deploy.DeploymentError("previous_attempt_unresolved"), value)["status"], "failed")

    def test_unhealthy_service_blocks_deployment(self):
        value, runner, health = self.make()
        health.fail_check = True
        with self.assertRaises(deploy.DeploymentError):
            value.run()
        self.assert_no_dispatch(runner)

    def test_bot_requires_verified_backup(self):
        value, runner, _ = self.make()
        runner.verified_backup = False
        with self.assertRaisesRegex(deploy.DeploymentError, "planning_backup_unverified"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_first_unlabelled_bot_is_identified_from_image_source_hashes(self):
        value, runner, _ = self.make()
        runner.labels = {}
        self.assertEqual(value.run()["status"], "deployed")
        self.assertEqual(value.previous_revision, OLD)
        self.assertTrue(any(deploy.BOT_SOURCE_DIGESTS in args for args, _ in runner.calls))

    def test_unlabelled_mismatched_bot_cannot_be_deployed(self):
        value, runner, _ = self.make()
        runner.labels = {}
        original = runner.run
        def run(args, **kwargs):
            if deploy.BOT_SOURCE_DIGESTS in args:
                return json.dumps({"app/main.py": "0" * 40})
            return original(args, **kwargs)
        runner.run = run
        with self.assertRaisesRegex(deploy.DeploymentError, "runtime_revision_unverified"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_bot_migration_changes_require_review(self):
        value, runner, _ = self.make()
        runner.migrations = "app/planning/sql/009_new_schema.sql"
        with self.assertRaisesRegex(deploy.DeploymentError, "database_migration_requires_review"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_bot_exact_revision_and_health(self):
        value, runner, health = self.make()
        result = value.run()
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(result["revision"], NEW)
        self.assertEqual(runner.active_image, NEW_IMAGE)
        self.assertEqual(runner.labels["org.artem.source-revision"], NEW)
        self.assertIn(("wait", {"check_entities": True}), health.calls)
        self.assertFalse(value.journal.exists())
        commands = [args for args, _ in runner.calls]
        up = next(args for args in commands if "up" in args)
        self.assertIn("--no-deps", up)
        self.assertIn("--pull", up)
        self.assertIn("never", up)
        self.assertIn(value.config["loopbackOverlay"], up)
        self.assertFalse(any("down" in args for args in commands))
        self.assertTrue(any(args[0] == "bash" and args[1].endswith("verify-control-center-loopback.sh") for args in commands))

    def test_bot_unhealthy_candidate_rolls_back_image_and_source_not_data(self):
        value, runner, health = self.make()
        health.fail_wait = 1
        result = value.run()
        self.assertEqual(result["status"], "rolled_back")
        self.assertEqual(result["revision"], OLD)
        self.assertEqual(runner.head, OLD)
        self.assertEqual(runner.active_image, OLD_IMAGE)
        self.assertEqual(runner.labels["org.artem.source-revision"], OLD)
        self.assertFalse(any("restore" in args for args, _ in runner.calls))
        self.assertFalse(value.marker.exists())

    def test_rollback_failure_preserves_journal(self):
        value, runner, health = self.make()
        health.fail_wait = 2
        with self.assertRaisesRegex(deploy.DeploymentError, "rollback_failed"):
            value.run()
        self.assertEqual(json.loads(value.journal.read_text())["phase"], "rollback_failed")

    def test_timeout_after_possible_dispatch_does_not_race_a_rollback(self):
        value, runner, _ = self.make()
        runner.timeout_recreate = True
        with self.assertRaisesRegex(deploy.DeploymentError, "deployment_outcome_unknown"):
            value.run()
        self.assertEqual(json.loads(value.journal.read_text())["phase"], "outcome_unknown")
        self.assertEqual(sum("up" in args for args, _ in runner.calls), 1)
        self.assertEqual(runner.head, NEW)
        self.assertEqual(deploy.failure_result(value.target, NEW,
            deploy.DeploymentError("deployment_outcome_unknown"), value)["status"], "failed")

    def test_same_healthy_bot_does_not_rebuild(self):
        value, runner, _ = self.make()
        runner.head, runner.labels = NEW, {"org.artem.source-revision": NEW}
        self.assertEqual(value.run()["status"], "up_to_date")
        self.assert_no_dispatch(runner)

    def test_source_keeps_exact_trailing_newlines(self):
        value, _, _ = self.make("home-assistant")
        self.assertEqual(value.source(SOURCE), b"template:\n  - sensor: []\n\n")

    def test_source_symlink_is_rejected(self):
        value, runner, _ = self.make("home-assistant")
        runner.mode = "120000"
        with self.assertRaisesRegex(deploy.DeploymentError, "invalid_source_file"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_package_destination_cannot_escape(self):
        value, runner, _ = self.make("home-assistant")
        value.config["managedFiles"][0]["destination"] = "packages/../../secrets.yaml"
        with self.assertRaisesRegex(deploy.DeploymentError, "invalid_path"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_package_does_not_overwrite_unmanaged_configuration(self):
        value, runner, _ = self.make("home-assistant")
        value.config["managedFiles"][0]["destination"] = "configuration.yaml"
        with self.assertRaisesRegex(deploy.DeploymentError, "invalid_packages"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_known_component_files_move_with_package_in_one_transaction(self):
        value, runner, _ = self.make("home-assistant")
        for name in deploy.HA_COMPONENT_FILES:
            destination = "custom_components/artem_panel/" + name
            source = "integration-patches/home-assistant/config/" + destination
            value.config["managedFiles"].append({"source": source, "destination": destination})
            runner.sources[source] = "content = 'controlled fixture'\n"
        self.assertEqual(value.run()["status"], "deployed")
        for name in deploy.HA_COMPONENT_FILES:
            self.assertEqual((self.root / "ha-config/custom_components/artem_panel" / name).read_text(),
                             "content = 'controlled fixture'\n")
        self.assertEqual(sum("up" in args for args, _ in runner.calls), 1)

    def test_partial_component_and_unknown_component_file_are_rejected(self):
        for name, error in [("__init__.py", "incomplete_ha_component"), ("arbitrary.py", "invalid_packages")]:
            value, runner, _ = self.make("home-assistant")
            destination = "custom_components/artem_panel/" + name
            source = "integration-patches/home-assistant/config/" + destination
            value.config["managedFiles"].append({"source": source, "destination": destination})
            runner.sources[source] = "content = 'controlled fixture'\n"
            with self.subTest(name=name), self.assertRaisesRegex(deploy.DeploymentError, error):
                value.run()
            self.assert_no_dispatch(runner)

    def test_ha_package_validation_then_apply_readback(self):
        value, runner, health = self.make("home-assistant")
        before = (self.root / "ha-config/configuration.yaml").read_bytes()
        result = value.run()
        self.assertEqual(result["status"], "deployed")
        self.assertEqual((self.root / "ha-config" / PACKAGE).read_bytes(), value.source(SOURCE))
        self.assertEqual((self.root / "ha-config/configuration.yaml").read_bytes(), before)
        self.assertEqual(runner.active_image, OLD_IMAGE)
        self.assertFalse(any(args[:2] == ["docker", "pull"] for args, _ in runner.calls))
        self.assertIn(("check", {"check_entities": False}), health.calls)
        check = next(args for args, _ in runner.calls if args[:2] == ["docker", "run"])
        self.assertIn("none", check)
        self.assertIn("check_config", check)
        self.assertFalse((value.transaction / "check-config").exists())

    def test_invalid_ha_syntax_leaves_live_package_and_container(self):
        value, runner, _ = self.make("home-assistant")
        runner.fail_syntax = True
        with self.assertRaisesRegex(deploy.DeploymentError, "command_failed"):
            value.run()
        self.assertEqual((self.root / "ha-config" / PACKAGE).read_text(), "old: true\n")
        self.assert_no_dispatch(runner)

    def test_ha_failed_readiness_restores_packages_without_database(self):
        value, runner, health = self.make("home-assistant")
        database = self.root / "ha-config/home-assistant_v2.db"
        database.write_bytes(b"persistent history")
        health.fail_wait = 1
        self.assertEqual(value.run()["status"], "rolled_back")
        self.assertEqual((self.root / "ha-config" / PACKAGE).read_text(), "old: true\n")
        self.assertEqual(database.read_bytes(), b"persistent history")
        self.assertEqual(runner.active_image, OLD_IMAGE)
        self.assertIn(("wait", {"check_entities": False}), health.calls)

    def test_removed_new_package_on_rollback(self):
        value, _, health = self.make("home-assistant")
        (self.root / "ha-config" / PACKAGE).unlink()
        deploy.atomic_json(value.marker, {"revision": OLD, "image": OLD_IMAGE, "fileHashes": {}})
        health.fail_wait = 1
        self.assertEqual(value.run()["status"], "rolled_back")
        self.assertFalse((self.root / "ha-config" / PACKAGE).exists())

    def test_ha_unknown_old_revision_stays_blocked_after_healthy_rollback(self):
        value, _, health = self.make("home-assistant")
        value.marker.unlink()
        health.fail_wait = 1
        result = value.run()
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["revision"])
        self.assertTrue(result["runtimeHealthy"])
        self.assertEqual(json.loads(value.journal.read_text())["phase"], "rollback_revision_unknown")

    def test_unchanged_ha_packages_do_not_restart(self):
        value, runner, _ = self.make("home-assistant")
        (self.root / "ha-config" / PACKAGE).write_bytes(value.source(SOURCE))
        self.assertEqual(value.run()["status"], "up_to_date")
        self.assert_no_dispatch(runner)

    def test_matching_files_without_loaded_entities_are_not_up_to_date(self):
        value, runner, health = self.make("home-assistant")
        (self.root / "ha-config" / PACKAGE).write_bytes(value.source(SOURCE))
        health.fail_wait = 1
        with self.assertRaisesRegex(deploy.DeploymentError, "health_timeout"):
            value.run()
        self.assert_no_dispatch(runner)
        self.assertEqual(json.loads(value.marker.read_text())["revision"], OLD)

    def test_floating_ha_image_is_rejected(self):
        value, runner, _ = self.make("home-assistant")
        value.config["imageManifest"] = "deploy/ha-image.json"
        runner.sources["deploy/ha-image.json"] = json.dumps({"schemaVersion": 1, "image": "ghcr.io/home-assistant/home-assistant:stable"})
        with self.assertRaisesRegex(deploy.DeploymentError, "unpinned_ha_image"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_ha_image_change_requires_confirmed_recorder_topology(self):
        value, runner, _ = self.make("home-assistant")
        value.config.update(imageManifest="deploy/ha-image.json", allowImageChange=True)
        with self.assertRaisesRegex(deploy.DeploymentError, "ha_image_change_not_configured"):
            value.run()
        self.assert_no_dispatch(runner)

    def test_ha_image_rollback_restores_consistent_stopped_data(self):
        value, runner, health = self.make("home-assistant")
        value.config.update(imageManifest="deploy/ha-image.json", allowImageChange=True, sqliteRecorderConfirmed=True)
        database = self.root / "ha-config/home-assistant_v2.db"
        database.write_bytes(b"before migration")
        original_copy = value.copy_config
        def copy(source, destination, *, complete):
            if complete and destination.name == "full-config":
                self.assertFalse(runner.running, "copy must happen after stop")
            return original_copy(source, destination, complete=complete)
        value.copy_config = copy
        def migrate():
            if runner.active_image == NEW_IMAGE:
                database.write_bytes(b"incompatible candidate migration")
        runner.recreate_hook = migrate
        health.fail_wait = 1
        self.assertEqual(value.run()["status"], "rolled_back")
        self.assertEqual(database.read_bytes(), b"before migration")
        self.assertEqual(runner.active_image, OLD_IMAGE)
        failed = list(self.root.glob("ha-config.failed-*"))
        self.assertEqual(len(failed), 1)
        self.assertEqual((failed[0] / "home-assistant_v2.db").read_bytes(), b"incompatible candidate migration")

    def test_incomplete_full_backup_is_never_restored(self):
        value, runner, _ = self.make("home-assistant")
        value.config.update(imageManifest="deploy/ha-image.json", allowImageChange=True, sqliteRecorderConfirmed=True)
        database = self.root / "ha-config/home-assistant_v2.db"
        database.write_bytes(b"must survive")
        original_copy = value.copy_config
        def copy(source, destination, *, complete):
            if complete and destination.name == "full-config":
                destination.mkdir()
                raise OSError("simulated disk full")
            return original_copy(source, destination, complete=complete)
        value.copy_config = copy
        self.assertEqual(value.run()["status"], "rolled_back")
        self.assertEqual(database.read_bytes(), b"must survive")
        self.assertEqual(runner.active_image, OLD_IMAGE)


class BoundaryTests(unittest.TestCase):
    def test_health_urls_cannot_escape_loopback_or_redirect(self):
        for url in ["https://example.com", "http://localhost:18123", "http://127.0.0.1:18123?token=x",
                    "http://user:pass@127.0.0.1:18123", "http://192.168.1.2:80", "file:///etc/passwd"]:
            with self.subTest(url=url), self.assertRaises(deploy.DeploymentError):
                deploy.local_url(url)
        self.assertEqual(deploy.local_url("http://127.0.0.1:18123/"), "http://127.0.0.1:18123")
        self.assertIsNone(deploy.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com"))

    @unittest.skipUnless(os.name == "posix", "Linux executable adapter")
    def test_runner_failure_does_not_expose_stderr_or_secret(self):
        with self.assertRaisesRegex(deploy.DeploymentError, "^command_failed$"):
            deploy.Runner().run([sys.executable, "-c", "import sys; print('sensitive', file=sys.stderr); sys.exit(1)"])

    @unittest.skipUnless(os.name == "posix", "Linux executable adapter")
    def test_runner_preserves_exact_text_when_requested(self):
        result = deploy.Runner().run([sys.executable, "-c", "print(' value  \\n')"], strip_output=False)
        self.assertEqual(result, " value  \n\n")


if __name__ == "__main__":
    unittest.main()
