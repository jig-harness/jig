# M12 — Parallel-agent ergonomics (stub)

**What problem this solves.** Running several AI agents on one machine/repo
(worktree-based tools) hits real resource collisions: port clashes, heavy
test runs thrashing each other, shared git state (stashes), duplicate branch
names — each producing confusing false failures agents misdiagnose.

**Invariant.** Parallel agents on one machine are a designed-for condition:
deterministic per-worktree port allocation; a cross-worktree mutex serializing
heavy build/test runs (with CI bypass); branch reuse-before-create discipline;
documented bans on shared-state footguns (stash across worktrees, root
installs with the wrong package manager); teardown hooks that prompt
reflection (M8).

**Port sources**: docomply worktree-create/remove hooks + port allocator,
`with-resource-lock.sh` mutex, branch-discipline rules. Ports in Phase 5.

**Status**: stub.
