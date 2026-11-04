---
release: minor
---

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
