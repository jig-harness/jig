---
release: minor
---

### Added

- [M12's mappings](../modules/M12-parallel-agent-ergonomics/mappings.md) map T3 Code as a workspace runtime: a `t3.json` script with `runOnWorktreeCreate` runs the worktree create hook once it is imported into the project's actions, and a wrapper runs the remove hook, since T3 Code has no point before a worktree is removed. A dated assessment says what T3 Code offers Jig's tooling and when Jig would add a launcher provider or a dispatcher session runtime for it.
- The audit's `M12/worktree-hooks-wired` criterion recognises T3 Code: a tracked `t3.json` whose worktree-create script runs the create hook, with a documented step that imports it, counts as wired creation, and removal counts as wired only when the repository tracks how the remove hook is reached and documents the project's automatic worktree cleanup as off. **Consumer action:** none.
