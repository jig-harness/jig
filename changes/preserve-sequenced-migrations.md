---
release: patch
---

### Fixed

- Conflict resolution keeps both sides' sequenced migrations when their numbers collide and checks the staged result for missing migrations and changes to the integration journal's applied entries.
- An unfinished pull request conflict repair aborts its merge, clears new untracked files and reports any worktree state it could not clear.
