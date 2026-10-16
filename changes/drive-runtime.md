---
release: minor
---

### Added

- Opt-in drive timing traces with child-process context and command
  durations. Enable them with `JIG_TRACE=1` or choose a file with
  `JIG_TRACE_FILE`; `reap-state.ts` removes trace days older than 14 days.

### Changed

- Share retry and polling policies across the runtime (a retry takes a
  required classifier and rethrows any error it does not name as transient
  at once), and release live resources in reverse acquisition order through
  one process-wide cleanup registry on normal completion, errors and
  termination signals.
