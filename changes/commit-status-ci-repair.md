---
release: minor
---

### Added

- A drive repairs CI that reports as GitHub commit statuses rather than
  GitHub Actions runs (Jenkins through its GitHub Branch Source plugin, for
  one). Its CI-repair pass is told each failing status with the page it
  links to (`DRIVE_PR_ROUND_FAILED_STATUSES`, beside the failed runs), and
  `/jig:fix-ci --pr <n>` reads every failing status on the pull request's
  head. Two `ci` fields serve such a repository: `ci.log_command` prints a
  status's failed log (it reads `{context, target_url}` on stdin, and exits 3
  when the log is gone), a command the repository supplies, run as its
  default branch sets it, and `ci.repair_skill` names the skill the repair
  pass loads first. The audit reports a `ci.repair_skill` that resolves to no
  installed skill. See [CONFIGURATION.md](../plugin/CONFIGURATION.md#ci).

### Changed

- A commit status in state `error` whose description says the build was
  aborted reads as cancelled, as a cancelled check run does: the drive waits
  for a new status and spends no CI-repair pass on it, and `fix-ci` leaves it
  out of the failures it reports.
