# AVALAR Website Integration Gaps

Discovery date: 2026-07-29  
Sources: `/Users/aartemida/Documents/AVALAR` and read-only SSH alias
`avalar-reg`  
Branch inspected: `stage` at `540b053f8ee8ce00239211279554869cd2a0bb6c`  
Mode: read-only

All items below are `NOT APPLIED — READ-ONLY DISCOVERY`.

## Verified current model

- Repository: `decorum-guy/AVALAR`.
- Simple PHP site with no Composer, npm build, framework, Docker, or package
  manifest.
- Content is primarily PHP templates, static assets, uploads, and `data.json`.
- `.htaccess` routes through `router.php` and blocks direct access to common
  internal/env paths.
- `stage` and `main` are separate branches/environments.
- `origin/main` at discovery time was merge commit
  `f438748e7307b48339048bc38fa4bca13e881e14`, whose tree matched inspected
  `origin/stage`.
- `stage.avalar.pro` and `avalar.pro` use separate private Telegram env files
  selected by host in `mail.php`.
- There is no `/healthz`, `/health/live`, `/health/ready`, or protected details
  endpoint in the tracked application.
- No application release/deployed-commit marker exists.
- A tracked legacy/admin PHP component contains local `data.json` backup-writing
  behavior. It is not a Control Center backup contract and was not inspected for
  credential values.
- 53 non-sensitive PHP files passed syntax-only `php -l`. The sensitive legacy
  admin component was excluded from the validation output.

## Actual operator wrapper

The repository contains `scripts/update.sh`.

Verified stage path:

```text
./scripts/update.sh deploy stage
  → ssh avalar-reg "~/avalar.sh stage"
```

The user-stated older/equivalent form `avalar-reg ./deploy.sh stage` was not
found in the current local repository. Control Center must register a named
`avalar.deploy.stage` handler only after the server-side `~/avalar.sh stage`
implementation, checksum, lock behavior, output, and rollback are inventoried.
No deploy/restart command was run during discovery.

Read-only SSH subsequently verified that `~/avalar.sh` resolves to
`/var/www/u3520338/data/avalar.sh`. Its current stage path performs a Git fetch
and fast-forward-only pull, terminates user-owned `php-cgi` processes, then
curls the site. It has no discovered exclusive deploy lock, backup step,
release marker, or rollback step. Its smoke accepts HTTP 200/301/302/403 and
uses TLS verification bypass, so it is not sufficient as a Control Center
success criterion.

Live server state at discovery:

- stage checkout: clean `stage` at
  `721cae090a5c26f87ec0544bb364858cd7432dd4`;
- production checkout: clean `main` at
  `f438748e7307b48339048bc38fa4bca13e881e14`;
- stage and production homepages returned HTTP 200;
- `/healthz` and `/health/live` returned HTTP 404 in both environments;
- no `php-cgi` process was present at the observation instant.

## Gap plan

| External file/component | Confirmed state | Required change | Contract / reason | Security implications | Tests | Risk / order |
| --- | --- | --- | --- | --- | --- | --- |
| New public health endpoint | No application health endpoint | Add minimal `/health/live` or `/healthz` returning static service/environment identity | Health: process/router/PHP response only; no private paths | Must expose no secrets, server paths, warnings, or stack traces | curl stage/main; invalid method; content/schema test | Low; 1 |
| New protected readiness endpoint or restricted host handler | Current homepage smoke cannot distinguish PHP/data/runtime readiness | Check readable `data.json`, required templates, PHP runtime, and optional form dependency with bounded timeouts | Health/details contract | Authenticated/private-only; redact filesystem and Telegram details | dependency failure fixtures; timeout; auth tests | Medium; 2 |
| Deployment marker | No deployed commit/release marker | Write atomic root-owned marker during deploy outside public content, expose only safe commit/release via protected details | Data: environment, commit, deployed_at, deploy id | Never trust browser-supplied ref; do not expose checkout path | marker atomicity; mismatch; stale marker | Medium; 3 |
| `scripts/update.sh` / server `~/avalar.sh` | Local wrapper runs fixed SSH command; live handler does fetch + FF-only pull + PHP-CGI termination + permissive curl smoke, without discovered lock/backup/marker/rollback | Version/checksum the server handler; add exclusive lock, preflight, backup, exact target, strict TLS smoke, sanitized output, post-deploy verification | Action: named `deploy_stage`, no shell text | Forced-command/restricted agent; no arbitrary target/path/ref | dry-run contract tests; concurrency; dirty tree; TLS failure; failed health | High; 4 |
| Stage smoke | Screenshot artifacts exist but no tracked repeatable smoke runner | Add non-destructive HTTP/browser smoke for `/`, `/about`, `/service`, `/contact`, assets, and form validation without submission | Action/data: `smoke_stage` | Never send a real form or personal data | Playwright/HTTP exit codes and screenshots | Medium; 5 |
| Rollback | No application rollback contract in tracked repo | Separate named rollback to a recorded verified deployment; restore code/data independently | Action: explicit high-risk rollback | Never infer rollback automatically from arbitrary Git ref | failed deploy → previous marker/health; audit | High; 6 |
| Backup | No consistent project backup handler | Backup allow-listed dynamic data/uploads/private config separately from Git; add manifest/checksum/archive test | Backup: stage/main profiles | Private env encrypted; do not use web-root backup directory | archive test, checksum, restore to isolated stage | High; before deploy writes |
| Error handling | PHP can emit warnings and legacy pages remain | Production error display off; sanitized error log accessible only through restricted details | Details/logs | No raw traces or personal form content | provoke missing data/template in test env | Medium |
| Legacy admin/backup PHP component | Tracked opaque filename with write-capable backup behavior | Security review; remove from public routing or protect strongly; replace with registered backup handler | Security and backup boundary | Potential public write/data exposure; do not expose contents in Control Center | route denial, auth, CSRF, path/write tests | Critical; before control actions |
| Versioned dependencies | No package manager; vendored JS/CSS/assets | Inventory PHP version/extensions and vendored asset provenance | Runtime/dependency contract | Supply-chain tracking without adding runtime CDN | clean-host smoke; dependency/SBOM review | Medium |

## Proposed contracts

### Public live

```json
{
  "ok": true,
  "service": "avalar-site",
  "environment": "stage"
}
```

### Protected readiness/details

```json
{
  "ok": true,
  "service": "avalar-site",
  "environment": "stage",
  "release": {
    "commit": "<40-hex-or-null>",
    "deployed_at": "<ISO-8601-or-null>",
    "deployment_id": "<opaque>"
  },
  "components": {
    "php": "ready",
    "content": "ready",
    "templates": "ready",
    "contact_delivery": "unknown"
  }
}
```

### Deploy action

```text
registered id: avalar.deploy.stage
target: stage only
precheck: lock + clean known checkout + expected script checksum + backup
execute: restricted server handler equivalent to ~/avalar.sh stage
verify: marker + health + browser smoke
success: only after verification
rollback: separate registered action
```

## Safe current monitoring baseline

Before external changes, Control Center may use monitor-only checks:

- DNS/TLS and certificate expiry;
- homepage and representative route status/latency;
- required local asset retrieval;
- non-submitting browser smoke;
- distinction between stage and main.

It must not configure nonexistent `/healthz` URLs as factual endpoints.

External folder confirmation: `/Users/aartemida/Documents/AVALAR` was not
modified. The `avalar-reg` host was queried read-only; no command that deploys,
restarts, fetches, pulls, writes a marker, or changes a service was executed.
