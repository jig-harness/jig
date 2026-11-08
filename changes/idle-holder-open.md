---
release: patch
---

### Fixed

- `jig dispatch` no longer refuses a pull request's re-arm on every tick while a worktree Orca does not list (an agent's leftover isolation worktree, or one another tool made) holds its head branch. When that worktree is idle (a clean tree, no unfinished git operation, no commit the remote's branch lacks, no live driver or session lease, and no process working in it), the open detaches it at its commit and creates the workspace on the branch. When it is in use, the launch is refused and a person is notified once, through the repository's notices workspace, with the worktree's path and what keeps it busy (cause `needs-person`), instead of the refusal being repeated in the log every tick. The idle test is shared code (`plugin/shared/idle-holder.ts`) for any step that takes a branch from another checkout.
