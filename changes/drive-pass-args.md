---
release: minor
---

### Added

- `drive.pass_args`, a list of words, gives a drive's Claude Code pass
  command extra arguments, written before `-p` in the command `arm-drive.ts`
  builds for `/jig:drive-pr` and `/jig:do-item`; `--pass-args "<words>"`
  on `arm-drive.ts` and `drive.ts` overrides it for one drive. Set it to
  `[--permission-mode, bypassPermissions]` to let unattended passes write
  under protected paths such as `.claude/skills/**`, which a pass without a
  terminal is otherwise denied, at the cost of every permission prompt;
  the default is empty
  ([configuration](../plugin/CONFIGURATION.md#drive)). The driver log and
  `drives.ts` name the permission mode each pass runs in, re-arm and
  takeover commands carry the arguments, a pass command that is not Claude
  Code's ignores the field and says so, and a value that is not a list of
  words stops the drive.
