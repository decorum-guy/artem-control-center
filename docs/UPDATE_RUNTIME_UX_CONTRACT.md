# Control Center update UX contract

The Windows updater remains the owner of the update transaction. The Panel
Agent exposes only its bounded, server-owned interpretation to the dashboard;
the browser never decides whether an update failed.

The status response keeps the existing `schemaVersion: 1` and adds:

- `progressPercent`: an integer from 0 through 100, derived from the fixed
  updater phase map. `100` is emitted only when the expected target is both
  recorded as served and verified as an `accepted-v2` production build.
- `events`: at most 32 `{code}` entries from the fixed vocabulary `started`,
  `stopping`, `checkout`, `handoff`, `target-authoritative`, `validating`,
  `building`, `artifact-ready`, `restarting`, `verifying`, `rollback`, and
  `completed`.
- `phase`: the current fixed transaction phase, when one is known.
- `result`: the existing fixed terminal result/error code, when one is known.

The dashboard maps event codes to fixed copy. It never renders updater logs,
stdout/stderr, commands, paths, environment values, tokens, PIDs, exceptions,
or arbitrary text. Reconnecting preserves the last known transaction snapshot;
rollback remains a separate truthful phase and terminal result.

The updater publishes JSON atomically in the existing RuntimeRoot files. On
Windows PowerShell 5.1, the existing-destination `File.Replace` call receives
`[System.Management.Automation.Language.NullString]::Value`, which is a true
CLR null backup path. The first write still uses same-directory `File.Move`,
and repeated writes use same-directory replacement.

The update dialog remains the existing in-panel ceremony, expanded for a
1280×720 touch surface. There is no generic log endpoint, browser timeout,
audio, provider, STT, TTS, or action execution in this contract.
