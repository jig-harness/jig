---
release: minor
---

### Added

- M10 external-precondition registry, pluggable reference checks and a branch-protection checker with expiring waivers and bot-write checks. M11 defines one current issue per registry with automatic closure after recovery; the audit includes criteria for live checks and reconciliation.

### Fixed

- The changelog skill's release-access check no longer counts a `pull_request`-mode bypass of a `non_fast_forward` or `deletion` rule as freeing the release App: such a bypass admits merges only, so force pushes and deletion stay blocked for it.
