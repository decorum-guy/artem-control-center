# AVALAR Website Integration Gaps

Discovery date: 2026-07-29  
Sources: authorized local repository and read-only `avalar-reg` SSH discovery
Implementation: `decorum-guy/AVALAR#1`, not deployed

## Verified hosting model

AVALAR Main and Stage run as separate clean Git checkouts on REG.RU shared
hosting. A command cannot rely on a daemon, systemd service, persistent worker,
queue or process environment surviving in PHP. Operations must be short-lived
and finish below the hosting session limit.

Read-only SSH verified:

- Main: branch `main`, clean, commit `f438748e…`;
- Stage: branch `stage`, clean, commit `721cae090…`;
- no deployment marker/static metadata file;
- `~/avalar.sh status` is human-readable and takes about 0.16 seconds;
- the existing script can deploy/restart/promote/status, but status exposes
  paths and there is no machine JSON, lock, cooldown, backup or rollback;
- both roots returned HTTP 200; the not-yet-deployed health routes returned
  HTTP 404.

## Implemented in the Draft PR

| Component | Confirmed prior state | Implemented change | Contract and tests | Remaining risk |
| --- | --- | --- | --- | --- |
| PHP health | No application health route | Stateless public `/health/live` and `/health/ready` without env vars | Minimal schemas; readiness checks readable/valid `data.json`; PHP tests assert no path/env leakage | Must be deployed to Stage/Main before Panel polling becomes live |
| HTTP details | No reliable shared-hosting secret storage | No `/health/details`; details are SSH-only | Deleted HTTP details route/token/env dependency | Optional SSH feature remains disabled by default |
| SSH details | `~/avalar.sh status` is human-oriented | `control-center-status.sh` allow-lists status/details for Main/Stage and emits sanitized JSON | Git checkout fixtures; schema, branch, clean tree and no absolute path tests | Repo-side script is not installed on server |
| Smoke | Existing server smoke uses permissive TLS behavior | Wrapper curls `/health/live`, `/health/ready` and `/` with bounded strict TLS requests | Main/Stage URL and JSON result tests | Health endpoints are not deployed |
| Stage deploy | Existing `scripts/update.sh` delegates to `~/avalar.sh stage` | Thin wrapper is dry-run by default; execute needs explicit operator gate, lock, cooldown, timeout ≤150 seconds and post-smoke | Allow-list, dry-run, arbitrary/prod action rejection and timeout bounds | A real deploy duration was not measured; executor remains disabled |

The integration uses SSH option A for deployment metadata. No static metadata
file is introduced because deployed checkouts already provide commit/branch
truth and no reliable deployment marker exists.

## Service contract

- `avalar-site-main`: production, priority 90, curl monitor, optional SSH
  details, no deploy capability.
- `avalar-site-stage`: stage, priority 80, curl monitor, optional SSH details,
  disabled Stage deploy capability.

Panel Agent public cadence is 20–30 seconds. Optional SSH details cadence is
2–5 minutes and uses fixed subprocess arguments, host-key verification,
timeout, output limit, JSON validation and cached/stale behavior.

## Remaining operational gaps

1. Review and install the status wrapper as a fixed server command.
2. Deploy health endpoints to Stage, smoke them, then propagate through the
   normal reviewed stage-to-main process.
3. Measure Stage deploy duration. Until it reliably fits the hosting limit,
   keep execution disabled.
4. Design verified backups and a separate recorded rollback before registering
   either capability.
5. Review the legacy write-capable admin component.

No deploy, restart, branch merge, HA action or persistent SSH write was
performed. One transient `/tmp/acc-avalar-status.<pid>` capture file was
mistakenly created and removed during read-only discovery; no checkout or
service state changed.
