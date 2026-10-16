---
release: minor
---

The fleet-health sensor now reports an epic census beside its stuck-epic signal.

### Added

- `fleet-health.ts` reports read-only signals about started epics: `finished-but-open` (every child closed, the epic still open), `tail-blocked` (at least 80% delivered with one or two children open) and `orphan-risk` (no children, project, owner or repository label). None is commented on an epic, and each reminds that closing an epic requires an accepting acceptance verdict or a waiver. Configuration: `signals.tail_blocked.*` and `labels.repositories` in the [fleet-health file](../plugin/CONFIGURATION.md#the-fleet-health-file); both are optional, so an existing file keeps loading.

### Changed

- The tracker port's `startedIssueActivity` now also returns each child's state and the epic's project, assignee and labels. A custom tracker adapter must supply them.
- A finished-but-open epic is no longer also reported as `stuck-epic`.
