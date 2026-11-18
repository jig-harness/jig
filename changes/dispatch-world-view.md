---
release: minor
---

### Changed

- The dispatcher's tick reads the forge and the tracker through one
  [world view](../GLOSSARY.md): which repository a checkout is and its
  configuration on the default branch, the open pull requests with their
  drive ledgers, the merges with their follow-up markers, and the tracker's
  queues. A program that runs a tick in process can supply its own view, or
  wrap the direct one; `jig dispatch` and its scheduled job read through the
  direct view, which makes exactly the reads the tick made before, so
  nothing changes in what a tick reads, plans, launches or reports. Every
  fact the view returns carries its [freshness class](../GLOSSARY.md):
  active (at most 10 minutes stale) for an open pull request whose drive
  runs or is armed, background (at most 75 minutes) for everything else. A
  fact a write depends on, such as a launch's fresh read of its pull
  request or a claim's read-back, is never served by the view: it is still
  read on the forge or the tracker at use. **Consumer action:** none.
- The observe phase keeps the [machine view](../GLOSSARY.md) apart from the
  world view: it no longer writes the drives this host's launch records
  settle (a re-drive already made, a takeover already tried) into the
  forge's own read, but keeps them in a list of their own, which every
  later stage plans from. The plan, the labels, the line and the receipt
  read the same drives as before. **Consumer action:** none.
