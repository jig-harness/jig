---
release: minor
---

The dispatcher, resource collection and the two machine-wide locks now record the same process identity and judge it by the same rules, and the drive's locks share its host comparison, so a restart or a renamed machine no longer leaves work waiting for a person.

### Added

- One shared [process identity](../GLOSSARY.md) (`plugin/shared/liveness.ts`): the machine's host id, which survives a rename and a restart (read from the system's machine id, or created once in `~/.local/state/jig/host-id` where there is none), its host name, the boot, the process id and the process's start time, with one set of rules for judging a recorded holder: dead after its host restarted or once its process id belongs to another process, unknown on another machine.

### Changed

- `jig dispatch`: a launch record claimed on this host before it last restarted now reads as died, frees its account's slot, and its outcome row says the host restarted; before, it held the slot as unknown until a person ran `jig dispatch clear`. A record claimed on another host, or read while the process table cannot be, still holds its slot as unknown. A record written before host ids is compared by its host name.
- `drive-pr`'s driver locks and `jig dispatch` compare hosts by host id before host name, so a machine whose host name changed (as a laptop's can between networks) still recognises its own driver and its own launches, and a claim from another machine is never judged by this one's process table. A driver lock's claim gains the host id after its platform; a claim without one is compared by name as before.
- `jig gc`: each admission token and the collector's own lock file hold their process identity, and a collection that meets a stale token names the token's creator and why it counts as gone. A stale token is still never removed by gc. Tokens and lock files in their earlier forms are read as before.
- The resource lock (`with-resource-lock.ts`, which `jig gc` and heavy test runs wait on) records its holder's identity beside the lock and, on Linux and macOS, reclaims a lock whose process id now belongs to a process that started later instead of waiting out `LOCK_TIMEOUT`. A reclaim, and a wait that runs out, say whose lock it was. The lock itself still names only the process id, so an earlier version keeps excluding this one ([M12](../modules/M12-parallel-agent-ergonomics/reference/resource-lock/README.md)).
- The Orca card lock holds its owner's identity, reclaims a lock whose process id now belongs to another process, and warns whose lock it took over.
