---
release: minor
---

The dispatcher admits Codex accounts beside Claude Code's, and the drive documents a Codex pass command.

### Added

- **A documented Codex pass command for the drive.** Beside Claude Code's
  `claude -p "/jig:drive-pr --bots-only <PR>"`, `drive-pr` now documents
  Codex's: `codex exec --dangerously-bypass-approvals-and-sandbox "Use the
  jig:drive-pr skill: /jig:drive-pr --bots-only <PR>"`. A Codex pass runs
  on its own `-m`, else the execution tier of `routing.models.codex`, else
  Codex's own configured model; `drive.pass_model`, `--pass-model` and
  `drive.pass_args` stay Claude Code's. `arm-drive.ts` in a Codex session
  arms a drive with Codex's command, in an Orca terminal tab where it can
  and otherwise as the printed command. A Codex pass has no turn cap of its
  own, since the turn-budget hook counts nothing under Codex: the pass
  deadline (`DRIVE_PR_PASS_TIMEOUT`, 90 minutes by default) is what ends one
  that runs on.
- **Codex accounts in the dispatcher.** An account's `vendor` in
  `~/.jig/dispatch.yaml` now picks the agent every session on it runs in. A
  drive re-armed on a `codex` account runs Codex's pass command with
  `CODEX_HOME` set to the account's directory and `CLAUDE_CONFIG_DIR` and
  every credential variable removed, so a drive stopped on a Claude Code
  account's usage limit is re-armed on a Codex account at the next run. A
  pickup on a Codex account starts Codex on the route's
  `routing.models.codex` model and `routing.efforts.codex` effort (where the
  session runtime can bind it; on Orca these stay reported); a follow-up
  starts Codex on its own defaults. A repository
  names a model per runtime in `routing.models`, never an agent.
- **A deadline for every dispatched drive.** Each drive the dispatcher
  launches runs under the pass deadline the run read (`DRIVE_PR_PASS_TIMEOUT`
  in its environment, else 90 minutes), kept on its launch record and handed
  to `drive.ts` as `--pass-timeout`. A `codex` account is not admitted for a
  drive while that deadline is `0`, since nothing else would bound its pass.

### Changed

- **Any vendor name in the machine file.** `accounts[].vendor` accepts any
  lowercase name. An account of a vendor the drive documents no pass command
  for is accepted, reported at the top of every run and in its receipt
  (`accountsNotAdmitted`) as accepted and not admitted, and never launched
  on.
