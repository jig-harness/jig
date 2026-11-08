---
release: minor
---

### Added

- A drive whose converged head's failing checks all failed on the CI
  service's infrastructure (a lost runner, or a setup step's network failure
  such as a tool download answering 504, with no code error in the log) no
  longer spends its CI-repair passes on them. It re-runs the failed jobs
  (`gh run rerun <run> --failed`, `DRIVE_PR_CI_INFRA_RERUNS` per head, default
  2). Where a run cannot be re-run, as with a default-setup code scan, or
  the re-runs are spent, it moves the head: it merges the base when the branch
  is behind it, and otherwise pushes the empty commit `ci: re-run checks after
  an infrastructure failure` (`DRIVE_PR_CI_INFRA_HEAD_MOVES` per drive,
  default 2). Past both bounds it stops with the new exit `23`
  (`CI_INFRA_PERSISTED`).
- `jig dispatch` re-drives a drive stopped `23` once per stop, after a backoff
  that starts at 15 minutes and doubles with each such stop in a row, up to 4
  hours. It tells a person only once 7 such stops stand in a row. A tick inside
  the backoff launches nothing.
- `fix-ci`'s `parse-ci-log.ts` prints an `infrastructure` reading beside the
  errors: whether every failed job failed on the infrastructure, and why. It
  is the same rule the drive applies, from `shared/ci-infra.ts`.

### Fixed

- A drive no longer stops `21` (`CI_REPAIR_SPENT`) over checks no code change
  could fix. Before, the dispatcher left such a stop for a person once its
  head had been re-driven, and the head moved only when a person moved it.
- Recovery preserves each failing job's workflow-run identity and rejects
  missing provenance, mixed code failures and unreadable base-sync reports.
  Base merges pass through a validated review round before their push;
  retry budgets reject unsafe or excessive numeric values.
- Pytest collection errors remain code failures even when the runner also
  shuts down. Empty recovery commits verify their reviewed parent and tree
  under the worktree fence, and only that certified commit can be pushed.
