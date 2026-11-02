---
release: minor
---

### Added

- **Serialized change areas.** An area of the
  [change-area catalog](../plugin/skills/change-areas/README.md#the-catalog)
  may say `serialize: true`, validated like its other fields: its pull
  requests conflict with each other whenever two move at once (a migrations
  folder, a schema). The
  [dispatcher](../plugin/README.md#the-dispatcher) reads the catalog from
  the default branch and each open pull request's changed files, groups
  the pull requests by the serialized areas they touch, and drives one per
  group at a time: the one closest to merge, in a fixed order read from the
  ledger and the forge (converged and mergeable, then a drive in progress,
  then the fewest unresolved review threads, then the most rounds, then the
  oldest). The others get no re-arm, takeover or re-drive and are reported
  as `held: serialized behind #N in <area>`; when the leader merges or
  leaves the group, the next run promotes the next. A drive a person arms
  on a held pull request is not stopped, and the run reports that the group
  has two drives.
- **The `held` dispatch label** (`jig:held` by default) shows a held pull
  request on the forge. A repository with dispatch labels on creates it by
  running `jig install dispatch --repo <clone> --yes` on the dispatching
  host once more.
- **How long contended work waited**: each hold's start and end is an event
  row in the dispatcher's outcome log, the end with the time it waited,
  which the dashboard shows.
- **`history.ts --propose-serialize`** in
  [resolve-conflicts](../plugin/skills/resolve-conflicts/README.md#where-past-merges-conflicted)
  prints, from the measured conflict hotspots, the `serialize: true` lines
  a person would add to the catalog for the areas a hotspot lies in alone.
  It writes nothing.
