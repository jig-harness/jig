---
release: minor
---

The drive keeps its machine state in one SQLite database per machine instead of a folder of files per clone, and a clone's earlier folder is imported once, at the first open, and left in place.

### Changed

- **Breaking:** `drive-pr` keeps its machine state in `~/.local/state/jig/drive-pr/state.sqlite` (under `$DRIVE_PR_STATE_DIR` when it is set), one database per machine with every row keyed by the clone: the drive state of each pull request, the store's lock, the driver locks, the session and tree leases, the remote-mutation lock, the held-item and Ready-mark claims, the stop requests and the driver record. A lock's release deletes its row, so nothing is left behind and the state no longer grows a tombstone per lock. The first drive command a clone runs reads that clone's earlier folder, `~/.local/state/jig/drive-pr/<clone>/`, into the database once, records the import, and leaves every file in place; stop running drives before upgrading, since a drive still on the earlier release keeps writing files the database no longer reads (its ledger on the pull request still carries its progress). The folder keeps the driver log, the kept answers, the long pass notice and the arm output. To move the state root, stop every drive, move the root whole and export the new `$DRIVE_PR_STATE_DIR` ([drive-pr README](../plugin/skills/drive-pr/README.md#relocating-the-state-dir)).
- A lock or a lease records its holder's process identity (host id, boot, process and start time), so a holder that died, or whose process id now belongs to another process, is recovered at once rather than after its heartbeat ages out; a lease's generation only grows, so a command admitted before a takeover is still refused when it comes to mutate, and a pass whose lease was taken over is still refused its post.
- The drive ledger names its clone by the clone key and a digest of the host's id (`<clone>@<host>`), so a reader can tell which host claims a drive; a ledger an earlier release wrote still seeds.
- `reap-state.ts` removes only files: a merged pull request's logs, answers, notices and arm output, and an earlier release's files 30 days after the import. Its JSON report drops the lock-compaction counts, and resource collection's `tool-state` kind reads the shorter report.
- The dispatcher's database opens through the shared `shared/records/db.ts`, which also records a database's minimum reader: a copy one release behind keeps using a database a newer copy changed only by adding tables or columns, and refuses one that needs a newer reader, naming both versions.
- The drive mailbox's append lock is a file created exclusively beside the mailbox file and removed on release, leaving nothing behind.

### Removed

- `migrate-state-dir.ts`, `migrate-legacy-state.ts` and `portable.ts recover-state`: the database's one-time import replaces them. State a much older release kept inside `.git` is not imported; a drive starting there seeds from its ledger.
