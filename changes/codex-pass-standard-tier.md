---
release: patch
---

### Fixed

- CONFIGURATION.md's `accounts[].vendor` now says a drive's pass on a
  `codex` account runs on the standard tier of `routing.models.codex` (by
  default `terra`, given as `gpt-5.6-terra`), the tier name routing uses,
  rather than the execution tier.
