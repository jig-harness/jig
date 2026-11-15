---
release: patch
---

### Fixed

- GitHub conditional reads answered unchanged now record request traffic with
  zero primary quota cost, including when the CLI exits nonzero or response
  headers are stripped. Budget reports retain that traffic separately, and
  low-quota forecasts use the charged cost rather than unchanged traffic.
