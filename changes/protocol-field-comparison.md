---
release: minor
---

### Added

- Each field in a [Jig Protocol](../plugin/protocol/README.md) data file now
  states `comparedAs`, what a stable chapter promises about its content within
  one version: `exact`, `prose` (may be reworded), `names` (a comma-separated
  list that may gain a name and never loses one) or `carriers` (what carries a
  value, each with `always` or `sometimes`). Rewording a command's `given`, or
  adding a skill to its `runBy`, no longer needs a new chapter version.
