---
release: minor
---

### Added

- `/jig:do-item` and `/jig:drive-pr` arm a drive in a terminal tab of the
  pull request's workspace, titled `drive #<PR>`, when the session runs in
  an Orca workspace. The drive then outlives the session and shows its
  passes there, and the session that implemented the item ends without a
  drive running beside it. Elsewhere the drive starts in the session's
  background as before. Both skills arm through drive-pr's new
  `arm-drive.ts`, which prints the command, what to do next, the pass model
  and the commands that list and stop the drive. It opens no tab while a
  drive already holds the pull request, and confirms that `drives.ts` lists
  the drive it started. The tab is a fresh login shell of the user's, so
  `bun`, `claude` and the Claude account come from it; the session's
  configuration reaches it as the `JIG__` overrides and the layer
  selectors `JIG_HOME`, `JIG_OVERLAY` and `JIG_USER_LAYER`. A Windows host opens
  no tab: Orca's tab there can run `cmd.exe` or PowerShell, and the command
  is quoted for a POSIX shell.
- `do_item.arm_drive` says how a drive is armed: `auto` (the default: a tab
  where the session can open one, else the background, falling back to the
  background when Orca refuses the tab or the tab's drive is not listed in
  time), `tab`, `background` or `print` (the command only). Both skills read it
  ([configuration](../plugin/CONFIGURATION.md#do_item)).
- `drive.pass_model` names the model each pass runs on: a model id, a
  Claude Code alias, or a routing tier resolved through `routing.models`.
  The default is `sonnet`, Claude Code's alias for the latest Sonnet.
  `drive.ts --pass-model` overrides it for one run, as does `arm-drive.ts
  --pass-model` for one arm
  ([configuration](../plugin/CONFIGURATION.md#drive)).

### Changed

- Each pass of a drive whose pass command is `claude` now runs
  `claude --model <model>`: `drive.ts` adds the configured model when the
  pass command names none, so a drive with no setting runs on `sonnet`
  instead of Claude Code's default model. The driver log's `pass model:`
  line and the `drives.ts` listing name the model, and the re-arm and
  takeover commands the driver prints carry it. A pass command that is not
  `claude` chooses its own model as before.
- `/jig:work-batch` arms its drive through the same script.
