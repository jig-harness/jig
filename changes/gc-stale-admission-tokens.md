---
release: patch
---

### Fixed

- A scratch admission token left by a process that died no longer blocks
  every scratch collection until a person removes it. When a token's record
  names this host and the host proves its process gone (no process has that
  pid with that start time, or the host restarted since), the collector
  removes the token and logs it; the scratch collector likewise takes over
  the `writer` file of a collector that was killed. A token that may still be
  held, or that gc cannot prove gone (no record, a record written before
  records named a host, another host, an unreadable process table), still
  blocks and is kept, and `jig doctor gc` and the dispatch dashboard now
  raise one host need naming it, with the check a person makes.
