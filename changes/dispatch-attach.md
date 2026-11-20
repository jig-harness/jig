---
release: minor
---

### Added

- `jig dispatch attach <record>` follows a run on the process runtime: it
  prints the run's worktree, account, stage and how long it has run, then
  shows the run's output as it is written, until the run ends. Interrupting
  it leaves the run going.
- `jig dispatch attach <record> --take-over` takes such a run over: it holds
  the run's pull request or item in your name, as `jig send hold` does, so
  the dispatcher starts nothing on it; stops the run (a drive through
  `drives.ts --stop`, so its ledger reads stopped); records its end as
  yours (`by: person`), which frees the account's slot; and prints the
  command that resumes the Claude Code or Codex session in the worktree
  under the same account. Run again after an interruption, it finishes the
  take-over. Release the hold with `jig send <address> release` when you
  are done. Runs on Orca are refused: their tab already shows them.
