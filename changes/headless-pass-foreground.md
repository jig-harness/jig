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
  committed work before a long validation step, so a deadline or an
  interrupted gates run no longer leaves finished commits on the host only.
