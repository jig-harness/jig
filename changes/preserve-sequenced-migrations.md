---
release: patch
---

### Fixed

- Conflict resolution keeps both sides' sequenced migrations when their numbers collide and checks the staged result for missing migrations and changes to the integration journal's applied entries.
- Configuration audit now rejects sequenced-migration settings that conflict resolution cannot read at runtime.
- An unfinished pull request conflict repair preserves pre-existing ignored files, clears new untracked files and reports unavailable inventory before cleanup.
