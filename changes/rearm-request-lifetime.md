---
release: minor
---

### Added

- Use `jig send … withdraw-rearm` to withdraw a pending rearm request.

### Fixed

- The dispatcher binds each rearm request to a particular drive stop and retires it when that stop is superseded or the pull request closes. A missing or reused worktree, or a request waiting beyond 30 minutes, raises a need.

### Changed

- **Breaking:** A rearm label without a stop-bound request expires. **Consumer action:** required at instructions. Replace steps that apply the rearm label directly with the rearm command in Jig Send. Re-send older pending requests that still need to run. **Detect:** `text:jig:rearm`.
