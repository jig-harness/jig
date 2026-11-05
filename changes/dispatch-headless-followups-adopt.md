---
release: minor
---

### Added

- An adoption rule for the dispatcher, `dispatch.adopt`, off unless a
  repository turns it on (and needs the dispatch labels on): an open pull request with no drive ledger, opened
  by one of the rule's `authors` (by default the login the dispatcher reads
  the forge as) and updated within its `within` window (a week by
  default), draft or not, is armed as if a person had labelled it
  `jig:drive`, once per head commit. A bot's pull request is adopted only
  when the rule names the bot, and one carrying `jig:hold` never is. Each
  run reports the pull requests the rule adopted, with the reason
  ([CONFIGURATION.md](../plugin/CONFIGURATION.md#dispatch)).

### Changed

- The dispatcher's `followup` stage now starts each follow-up as a headless
  pass instead of reporting it: the account's non-interactive command
  (`claude -p`, `codex exec`) runs the repository's
  `dispatch.followup_command` on the merged pull request in its workspace,
  through the same wrapper as a drive's pass, bound to the admitted account
  by its configuration directory, under the pass deadline and with the
  host's own `drive.pass_args` or `drive.codex_bypass`. The marker claim,
  the launch record and the per-account caps are unchanged. A pass that
  needs a person stops and ends its output with a `Question:` line, and the
  failed follow-up's notification carries that question. Pickups are still
  reported and not started on Orca
  ([CONFIGURATION.md](../plugin/CONFIGURATION.md#the-machines-dispatch-file)).
