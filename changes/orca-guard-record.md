---
release: minor
---

### Added

- **`jig gc` and Jig's plugin for Orca share a launch guard record.** Before it removes a worktree Orca manages, gc writes an admission for it under `~/.local/state/jig/orca-guard/`, and it keeps the worktree when the plugin's launch marker for it is within its 120 s settling window or not older than the admission, whatever Orca's registry says. The admission is deleted whether the worktree goes or stays, and a collecting run deletes launch markers older than a day. The plugin's `agent.launch.before` hook reads the same files to refuse a launch into a worktree gc is removing, which closes the gap between gc's last read of Orca's registry and `orca worktree rm`. The format is a contract a dependency-free reader can follow: the directory per platform, one file per entry published by a rename, the key (the SHA-256 of the worktree's path as Orca reports it) and the three record kinds with their exact JSON ([gc/README.md](../plugin/gc/README.md#the-launch-guard-record), [RECORDS.md](../plugin/RECORDS.md)).
- **Each Orca checkout's receipt line says whether collection was guarded.** gc trusts the guard only while the plugin's heartbeat is less than 180 s old; without one it collects as before. `details.guard` is `guarded` or `unguarded`, the reason says why, and the report prints it beside the runtime, as in `(orca, unguarded)`.
