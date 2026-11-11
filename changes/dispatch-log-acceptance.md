---
release: minor
---

### Added

- `jig dispatch log --acceptance` reports, per repository and decision class,
  how many parked decisions the outcome log counted, how many were answered,
  how many of those took the recommended option with no note, and the median
  wait for an answer, over the parks that have been settled (`--jsonl` prints
  one JSON object a line, `--since` limits the period by settling time). It is evidence for deciding whether a class should stay a
  person's; nothing acts on it.
