---
release: minor
---

M11 now watches whether scheduled automation is still running, not only how it last finished.

### Added

- M11 process observability: **heartbeat**. Every scheduled job declares the cadence it must produce a result at, in a cadence registry ([`templates/scheduled-jobs.yaml`](../modules/M11-process-observability/templates/scheduled-jobs.yaml)). A job whose last result is older than its cadence plus grace, or that has produced none, is **stale** unless its failures in a row already make it red, and stale is never green; a job is exactly one of green, degraded, red, stale or running, with the number of failures in a row that make it red set per job. The watcher reports to an external monitor on success and on failure, so a watcher that itself stops is an incident (a dead-man's switch). The module README states the doctrine; its mappings list the monitor products, a run-history collector per provider and the watcher workflow for GitHub Actions and GitLab CI.
- M11 reference gates in [`reference/heartbeat/`](../modules/M11-process-observability/reference/heartbeat/README.md): `classify-heartbeat.ts` classifies each declared job from a run history and exits non-zero for a red or stale job, and fails closed on a history or registry it cannot trust (an impossible date, one run listed twice, an empty history makes every job stale, and the job that runs the classifier is declared with `watcher: true` and left out of the classification); `check-schedules-declared.ts` fails a scheduled workflow missing from the registry. Both have self-tests and fixtures.
- Audit criteria `scheduled-jobs-staleness-watched` (Standard) and `heartbeat-reports-to-external-monitor` (Strict) in M11. The `heartbeat` event gains optional `red_jobs`, `stale_jobs` and `red_or_stale_jobs` counts, and the metrics registry template a `scheduled-jobs-red-or-stale` metric.
- Jig declares its own scheduled workflow in `.config/scheduled-jobs.yaml`, and `bun run gates` fails a scheduled workflow that is not in it.
