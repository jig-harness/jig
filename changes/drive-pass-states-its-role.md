---
release: patch
---

### Fixed

- A drive's pass no longer reads its prompt as a request to arm or watch the
  drive. The pass command of each agent tool (Claude Code's
  `claude -p "/jig:drive-pr --bots-only <PR> …"` and Codex's
  `codex exec "Use the jig:drive-pr skill: …"`) now goes on, after the
  skill's invocation, to say it is one round of the drive already running on
  that pull request, that the drive it finds there is its own driver, and
  that it must finish the round: commit, merge the base when told, push,
  reply or park, and name what it could not do. drive-pr's `SKILL.md` states
  the same role and duties in its first section, before the arm procedure.
  A Codex pass that settled its role from the opening words used to arm a
  second drive, stand down for its own driver or leave its edits unpushed,
  and the drive stopped as stalled (exit 14). Drives already running keep
  their old pass command until they are next armed.
  **Consumer action:** none.
