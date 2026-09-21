import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const BEFORE = `sha256:${"b".repeat(64)}`;
const AFTER = `sha256:${"a".repeat(64)}`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const BASH_EXECUTABLE = process.platform === "win32"
  ? execFileSync("where.exe", ["bash.exe"], { encoding: "utf8" }).split(/\r?\n/).find(Boolean)?.trim()
  : "bash";

if (!BASH_EXECUTABLE) throw new Error("bash executable is required for home-maintenance contract tests");

function toBashPath(value) {
  if (process.platform !== "win32") return value;
  return execFileSync(BASH_EXECUTABLE, ["-lc", 'cygpath -u "$1"', "bash", value], { encoding: "utf8" }).trim();
}

const BASH_PATH = execFileSync(BASH_EXECUTABLE, ["-lc", 'printf "%s" "$PATH"'], { encoding: "utf8" });

function failed(fn) {
  try { fn(); } catch (error) { return String(error.stdout ?? ""); }
  assert.fail("expected helper to fail");
}

function fixture({ imageAfter = AFTER, health = "healthy", readinessUrl = "", config = "", missingService = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "home-maintenance-"));
  const configPath = join(root, "conf");
  const lock = join(root, "lock");
  const bin = join(root, "bin");
  const log = join(root, "command.log");
  const bashRoot = toBashPath(root);
  const bashConfigPath = toBashPath(configPath);
  const bashLock = toBashPath(lock);
  const bashBin = toBashPath(bin);
  const bashLog = toBashPath(log);
  mkdirSync(bin);
  writeFileSync(configPath, config || [
    `COMPOSE_PROJECT_DIR=${shellQuote(bashRoot)}`, `COMPOSE_FILE=${shellQuote(`${bashRoot}/compose.yml`)}`,
    "HA_SERVICE=ha", "CADDY_SERVICE=caddy", "BOT_SERVICE=bot", `HA_READY_URL=${shellQuote(readinessUrl)}`,
  ].join("\n"));
  const helper = readFileSync("scripts/linux/home-maintenance", "utf8")
    .replace("CONFIG=/etc/artem-control-center/home-server.conf", `CONFIG=${shellQuote(bashConfigPath)}`)
    .replace("LOCK=/run/lock/artem-control-center-home-maintenance.lock", `LOCK=${shellQuote(bashLock)}`)
    .replace("MAX_WAIT_SECONDS=180", "MAX_WAIT_SECONDS=1")
    .replace("curl --fail --silent --max-time 5 \"$url\"", `${shellQuote(`${bashBin}/curl`)} --fail --silent --max-time 5 \"$url\"`);
  const path = join(root, "helper");
  writeFileSync(path, helper); chmodSync(path, 0o755);
  const docker = `#!/usr/bin/env bash
echo "$*" >> "$LOG"
if [[ "$1" == inspect && "$2" == --format ]]; then
  case "$3" in
    '{{.Image}}') echo '${BEFORE}' ;;
    '{{.State.Running}}') echo true ;;
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}') echo '${health}' ;;
    '{{.Config.Image}}') echo ghcr.io/home-assistant/home-assistant:stable ;;
  esac
  exit 0
fi
if [[ "$1" == exec ]]; then echo 2026.1.0; exit 0; fi
if [[ "$1" == compose ]]; then
  [[ "\${COMPOSE_FAIL:-}" == 1 ]] && exit 1
  case " $* " in
    *' ps -q '*) [[ "\${MISSING_SERVICE:-}" == 1 ]] || echo container-ha ;;
    *' images -q '*) echo '${imageAfter}' ;;
  esac
  exit 0
fi
exit 1
`;
  writeFileSync(join(bin, "docker"), docker); chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(bin, "flock"), "#!/usr/bin/env bash\n[[ \"${FLOCK_BUSY:-}\" == 1 ]] && exit 1\nexit 0\n");
  chmodSync(join(bin, "flock"), 0o755);
  writeFileSync(join(bin, "curl"), "#!/usr/bin/env bash\necho \"curl $*\" >> \"$LOG\"\nexit 0\n");
  chmodSync(join(bin, "curl"), 0o755);
  return {
    path: toBashPath(path),
    log,
    env: {
      ...process.env,
      PATH: `${bashBin}:${BASH_PATH}`,
      LOG: bashLog,
      MISSING_SERVICE: missingService ? "1" : "",
    },
  };
}

function run(fixtureData, operation, extra = {}) {
  return execFileSync(BASH_EXECUTABLE, [fixtureData.path], {
    env: { ...fixtureData.env, SSH_ORIGINAL_COMMAND: operation, ...extra }, encoding: "utf8",
  });
}

test("rejects an unknown original command with bounded JSON", () => {
  const f = fixture();
  assert.deepEqual(JSON.parse(failed(() => run(f, "restart-ha; env"))), { schemaVersion: 1, ok: false, error: "invalid_operation" });
});

test("status projects only bounded service fields", () => {
  const f = fixture();
  const out = JSON.parse(run(f, "status"));
  assert.equal(out.services.homeAssistant.running, true);
  assert.equal(out.services.homeAssistant.healthy, true);
  assert.doesNotMatch(JSON.stringify(out), /COMPOSE_PROJECT_DIR|compose\.yml|PATH|LOG/);
});

test("missing fixed server configuration fails closed", () => {
  const f = fixture({ config: "COMPOSE_PROJECT_DIR=/srv/home\n" });
  assert.deepEqual(JSON.parse(failed(() => run(f, "restart-ha"))), { schemaVersion: 1, ok: false, error: "configuration_missing" });
});

test("an absent fixed HA service never selects a replacement", () => {
  const f = fixture({ missingService: true });
  assert.deepEqual(JSON.parse(failed(() => run(f, "update-ha"))), { schemaVersion: 1, ok: false, error: "update_failed" });
});

test("a fixed Compose failure has a bounded code", () => {
  const f = fixture();
  assert.deepEqual(JSON.parse(failed(() => run(f, "restart-caddy", { COMPOSE_FAIL: "1" }))), { schemaVersion: 1, ok: false, error: "compose_failed" });
});

test("unchanged image pulls and never recreates", () => {
  const f = fixture({ imageAfter: BEFORE });
  assert.equal(JSON.parse(run(f, "update-ha")).status, "up_to_date");
  const log = readFileSync(f.log, "utf8");
  assert.match(log, /compose .* pull ha/);
  assert.doesNotMatch(log, /force-recreate/);
});

test("changed image recreates only the fixed HA service and verifies it", () => {
  const f = fixture();
  assert.equal(JSON.parse(run(f, "update-ha")).status, "success");
  const log = readFileSync(f.log, "utf8");
  assert.match(log, /up -d --no-deps --force-recreate ha/);
  assert.doesNotMatch(log, /restart caddy|restart bot/);
});

test("each restart operation targets only its configured service", () => {
  for (const [operation, service] of [["restart-ha", "ha"], ["restart-caddy", "caddy"], ["restart-bot", "bot"]]) {
    const f = fixture();
    assert.equal(JSON.parse(run(f, operation)).status, "success");
    const log = readFileSync(f.log, "utf8");
    assert.match(log, new RegExp(`restart ${service}`));
    for (const other of ["ha", "caddy", "bot"].filter((name) => name !== service)) assert.doesNotMatch(log, new RegExp(`restart ${other}`));
  }
});

test("unhealthy readiness produces a bounded restart timeout", () => {
  const f = fixture({ health: "unhealthy" });
  assert.deepEqual(JSON.parse(failed(() => run(f, "restart-ha"))), { schemaVersion: 1, ok: false, error: "restart_recovery_timeout" });
});

test("a service without a healthcheck uses only its fixed configured readiness URL", () => {
  const f = fixture({ health: "none", readinessUrl: "http://127.0.0.1:8123/api/" });
  assert.equal(JSON.parse(run(f, "restart-ha")).status, "success");
  assert.match(readFileSync(f.log, "utf8"), /curl --fail --silent --max-time 5 http:\/\/127\.0\.0\.1:8123\/api\//);
});

test("a busy server lock returns its bounded code", () => {
  const f = fixture();
  assert.deepEqual(JSON.parse(failed(() => run(f, "restart-ha", { FLOCK_BUSY: "1" }))), { schemaVersion: 1, ok: false, error: "maintenance_busy" });
});
