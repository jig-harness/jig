---
release: minor
---

### Added

- The hub's storage: its tables, declared once with Drizzle and kept in
  partitions (one per repository, one per host, and one directory), and the
  one implementation of the storage port every adapter runs, over a
  synchronous SQLite database. Each change runs in one transaction with its
  statements prepared first, and the port gains an atomic batch of changes in
  one partition. The first tables hold the in-flight read row, so one unit at
  a time reads a target through, taken over 30 seconds after it was taken,
  and the job lease row, so two runs of one scheduled job never overlap.
  `drizzle-kit` generates the migrations from the schema; the hub has no
  command yet that opens the store.
- The hub's job helper and the trimming job's framework: a scheduled job runs
  its steps under a deadline and a lease that outlives it, storing its
  progress after each step, so a run that stops is resumed by the next one.
  The trimming job runs hourly and deletes, in chunks, the expired rows of
  each table that declares a retention rule. Only the in-flight reads have
  one so far; each later table declares its own as it arrives, by the
  periods [design/control-plane.md](../design/control-plane.md#how-long-it-keeps-things)
  sets.
- The plugin vendors Drizzle (`drizzle-orm` 0.45.4, Apache License 2.0) under
  `plugin/shared/vendor/`, built from the pinned package and listed in
  `NOTICE`.
- The records registry gains the hub medium, whose kinds are its
  tables ([RECORDS.md](../plugin/RECORDS.md#in-the-hub)).
