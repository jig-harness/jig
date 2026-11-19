---
release: patch
---

### Fixed

- A dispatched pickup stopped by a fault of its host rather than of its
  work (its result could not be written, its closing report gives the cause
  `environment`, or the question it stopped on is about exhausted space or
  inodes or a file system or state directory that cannot be written) no
  longer waits on a person. While the host's health check fails, the item is
  held with the fault named; once it passes, the tick relaunches the pickup
  in its own tree to resume the work, or picks the item up afresh when the
  pass never claimed it. A restart that stops on a host fault again raises
  one need for the steward or a person to diagnose, never a second restart.
