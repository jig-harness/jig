---
release: patch
---

### Fixed

- `jig dispatch` counts every live driver on the host against the slots of
  the account its passes bill, whoever started it. A drive a pickup armed
  keeps the pickup's slot once the pickup ends instead of freeing it, and a
  drive a person or a repair session started or took over by hand holds a
  slot too, so admission no longer launches past `max_per_account` while
  such drivers run. A driver whose process is gone frees its slot on the
  next tick. `jig dispatch line --json` lists these drivers in
  `line.drivers`, with the account whose slot each holds and how it was
  started.
