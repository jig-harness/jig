---
release: minor
---

### Added

- A dispatched follow-up whose pass finds an arm still pending (a release
  run still going, a deploy not started) records
  `jig dispatch result <record> <token> waits --until <time> --reason pending --arm <name>`.
  The dispatcher holds it until that time and starts it again, as it does a
  rate limit's wait, but never reports it as a rate limit and does not count
  it toward the rate limit's three waits in a row. A pass that still finds
  the arm pending once `dispatch.followup_within` has passed since the first
  pass that found it so is notified as a failed follow-up naming the arm.
  `--reason` absent is `rate-limit`, so existing callers keep their meaning.
  The follow-up pass's prompt says how to record it, and the `followup`
  skill's `settle` ends a dispatched run with a pending arm that way, the
  arm named.
- `dispatch.followup_command` defaults to `/jig:followup`, the plugin's
  follow-up skill, on a host whose machine file lists `followup` among the
  repository's `stages`. The stage stays opt-in per host: where it is off, a
  repository that names no command has no follow-ups, and its merged pull
  requests are not read for them.
