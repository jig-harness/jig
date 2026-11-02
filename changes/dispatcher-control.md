---
release: minor
---

The dispatcher shows how the stages it started went, and sends its one
nudge.

### Added

- **The outcome log.** Every session `jig dispatch` launched gets one row
  when it ends, in `~/.local/state/jig/dispatch/log-<year>-<month>.jsonl`,
  which nothing removes: the stage, repository, item or pull request,
  account, model, duration, a drive's rounds, and an outcome class from a
  closed list (converged, merged, quota wall, parked for a person, stalled,
  died, refused, gates failed, double claim, unknown) with the stage's own
  answer as its reason. A stop no class fits is logged as `unknown` with its
  last state. Each cause the dispatcher notifies on a stage it did not
  launch, and each nudge, is an event row beside them.
- **`jig dispatch dashboard [--port <n>]`**: one page over the log, filtered
  by time (today, yesterday, a range), repository, stage, account, class and
  reason, with the count of each class. It listens on the machine file's new
  `dashboard.listen`, an address in the private or loopback ranges, behind a
  token in the URL it prints, reads the log when the page asks and writes
  nothing.
- **Stage drift.** A drive the dispatcher launched whose unresolved review
  threads do not fall over `dispatch.drive_rounds_flat` recorded rounds (3),
  a pickup with no pull request after `dispatch.pickup_within` (2h), and a
  follow-up still running after `dispatch.followup_within` (1h) are reported
  as drifting with the evidence and notified once; the dispatcher never acts
  on drift.
- **The `steer` stage.** An interactive session the dispatcher launched now
  starts with a session id the dispatcher chose, so a usage-limit wall it
  meets is read from its own record and closes its account to admission
  like a drive's. Once that wall has reset and the session still waits at an
  empty prompt, the dispatcher types `Your usage limit has reset. Continue`
  into it once, after re-reading the screen; a session still waiting after
  that is notified, never nudged again. Enable it with `steer` in a
  repository's machine-file stages.
