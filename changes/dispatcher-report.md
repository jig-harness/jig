---
release: minor
---

### Added

- `jig dispatch`, the dispatcher's tick as a report: for each repository it
  reads the items assigned to the repository's factory identity, each open
  pull request's drive ledger and the sessions Orca runs, and prints every
  pickup, re-arm, follow-up and notification it would start, each with the
  record that wants it and the evidence, starting nothing. A stage a running
  session holds is listed as running, and a record it cannot read is
  reported, never planned. Each run writes a receipt that
  `jig dispatch receipts` lists; `--apply` is refused in this version. See
  [the dispatcher](../plugin/README.md#the-dispatcher) and the
  [`dispatch` section](../plugin/CONFIGURATION.md#dispatch) of
  `.config/jig.yaml` (`identity`, `states`, `followup_command`), which is
  read from the default branch only.
- The tracker interface reads the issues assigned to one user in given
  states (`assignedIssues`) and who made an issue's current assignment
  (`assignedBy`), on GitHub Issues and Linear.
