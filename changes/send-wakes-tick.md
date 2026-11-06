---
release: minor
---

### Added

- `jig send` wakes the dispatcher's tick for the repository after it writes an `assign`, `drive`, `hold`, `release` or `answer`, when this machine's dispatch file lists the repository with the stage the tick acts under. The tick runs as the installed timer runs it, at once or within a minute of the last one the wake started, instead of at the next timer run; several sends within that minute start one tick, and a tick refused because another holds the tick lock is tried again a minute later. The `next` line says which: "the dispatcher's tick for owner/name, woken now". Mailbox directives wake nothing, since the driver reads them at its next round ([plugin/README.md § Telling a station what to do](../plugin/README.md#telling-a-station-what-to-do)).
