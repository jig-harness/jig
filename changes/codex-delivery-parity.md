---
release: patch
---

### Fixed

- `do-item` and `drive-pr` now request Codex managed background execution
  when no terminal tab is available, with instructions for verifying startup
  and preserving the session for hosts that terminate child processes on exit.
- `arm-drive.ts` and `drive.ts` accept `--pass-model` for Codex, including
  routing tiers resolved through `routing.models.codex`, without applying
  Claude Code's default model to Codex.
