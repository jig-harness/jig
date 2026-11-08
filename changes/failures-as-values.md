---
release: minor
---

### Changed

- A defect in one stage of the dispatcher's `--apply` for a repository (its
  re-arm, pickup or follow-up launches, its nudges, its notifications, or the
  close that projects its labels) now stops that stage only: the
  repository's other stages still launch in the same tick. The receipt lists
  it under the repository's `stageDefects` with its code `defect`, its phase,
  its stage and a sentence; the outcome log gets an event row `defect` under
  that stage; its stack goes to the tick's error output; and the tick exits 1,
  as a defect that stops a whole turn makes it. `jig dispatch receipts` and
  the dashboard's tick strip count these defects too.
- A resource collection run whose configuration cannot be read still
  collects nothing and exits as before, and now writes a receipt that names
  the failure: a `failure` field with its `code` and `reason`, which
  `jig receipts gc` shows. Receipts written before it read as they did.
- The plugin's code now follows
  [ADR-0012](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0012-failures-as-values.md):
  a failure a caller handles is returned as a value with a stable code and a
  reason, and anything still thrown is a defect or one error class built on
  one base. Messages, exit codes and receipts are otherwise as they were.
