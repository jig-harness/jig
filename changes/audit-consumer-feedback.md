---
release: minor
---

The audit records the profile a team chose, keeps a first narrowed re-audit
readable, and reads more of a repository's deploy and gate setup.

### Added

- `score.ts --draft --profile <id> --declare` records the profile, with
  `--conditions` and `--heading-to`, as the team's declared choice, so a
  profile the person already chose is no longer set by hand in the record.
- Report source drift entries take `status: "applied"` and `applied_in`, as
  recommendations do: drift fixed in the same run shows on the
  [audit sheet](../plugin/skills/audit/references/report-sheet.md) as fixed.
- Configuration fit names an alternative profile in two more cases: the
  suggested profile when the record declares another, and Regulated/Strict
  when compliance documents sit beside Team/Standard.
- Deploy signals come from tracked files as well as CI: systemd service and
  timer units, a top-level deploy or infrastructure directory, a Procfile, a
  hosting platform's configuration, and workflows that run on a release or a
  pushed tag. Tests and their data, templates and vendored copies are left
  out, and a unit, Procfile or platform configuration that cannot be read is
  named as unchecked.
- `gates.command` suggestions find a gate script (`scripts/gates.sh` and
  similar names), preferring one that a CI command runs. When every CI run
  of it is one command a configuration can repeat, interpreter and
  arguments included, that is the suggestion; otherwise the suggestion names
  how CI runs it for a person to settle. An environment the workflow, job or
  step sets leaves the command to settle, and a `run` block with a
  here-document or a `cd`, or one that only mentions either, shows no run
  at all.
- The comparison of `gates.command` with CI names, as unchecked, the jobs
  whose `run` steps it does not read (a compound command, a here-document,
  a change of folder, another folder or shell), instead of passing over them.

### Changed

- With a profile, the sheet's headline counts the criteria within the
  target; criteria scored beyond it are counted on their own line, and
  criteria within it that the record left unexamined are counted as not
  judged.
- `record.ts compare` against a prior record that examined every criterion
  counts the criteria a narrower profile leaves unexamined in one line
  instead of listing each; the draft keeps their prior scores as comments.
- `do-item`'s `pr-plan.ts` leaves `.config/jig-audit.yaml` out of a pull
  request's size and says so.
- `M2/hand-editing-forbidden` accepts an inventory entry saying a file is
  not edited by hand where its format cannot carry a header. A practice
  that covers part of its scope scores its weakest part, as the
  [criteria README](../plugin/skills/audit/criteria/README.md) now shows with
  an example.
- The audit skill saves the prior record before step 6 overwrites it,
  leaves paths a repository's CODEOWNERS or protected-path inventory guards
  to a person in unattended runs, makes worktrees under the real path, and
  reads the prior record and the history before it at the audited commit. The snapshot `--at` makes is
  under its real path.

### Fixed

- `record.ts check` no longer reports as missing paths code identifiers,
  the audit's own scratch files, files the evidence proposes or says are
  missing, slash-joined alternatives, and the plugin's own scripts where
  every citation calls them the plugin's or Jig's. File names in capitals
  (`README.MD`) are still checked, and `add` or `create` passes over only
  the paths it proposes, a list joined by commas, `and` or `or` included.
- The sheet's alternative-profile line tells modules short on examined
  criteria from those it cannot judge because their criteria were not
  examined.
- An unprotected branch is reported as unprotected, apart from a protected
  one that requires no checks.
- The unnamed-reviewer warning says whether the default reviewer check
  pattern matches the check it saw;
  [CONFIGURATION.md](../plugin/CONFIGURATION.md) says the pattern matches
  without regard to case.
- Counts on the sheet agree in number ("1 quick win").
