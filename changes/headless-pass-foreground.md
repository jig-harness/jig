---
release: patch
---

### Fixed

- A dispatched pickup, follow-up or steward pass no longer ends, or runs out
  its deadline, waiting on a background task or agent. The dispatcher starts
  each with Claude Code's background tasks off
  (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), as the drive's passes already
  were, and each pass's prompt says to keep long steps in the foreground and
  bound every wait on another agent. A pickup's prompt also says to push
  committed work before a long validation step, unless the repository
  requires validation before every push. That cuts the chance a deadline or
  an interrupted gates run leaves finished commits on the host only; a push
  the pre-push hook refuses still waits for validation.
- A dispatched pickup that cannot arm its pull request's drive (the arm
  script answers `spawn`, which a pass with background tasks off cannot
  run) first checks for a drive already listed on it, and otherwise records
  the pull request as its result and says in its closing report that the
  drive is unarmed, with the command to run.
