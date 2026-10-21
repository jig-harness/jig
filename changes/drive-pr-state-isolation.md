---
release: minor
---

### Fixed

- **Breaking:** `drive-pr` now preserves clone isolation under `DRIVE_PR_STATE_DIR`: the override names a root with one `<clone-key>/` subdirectory per clone. Same-numbered PRs in different repositories no longer share state, logs, leases or driver locks. Stop all participants before upgrading an existing flat override, establish each artifact's owner and explicitly relocate complete state into the appropriate clone directory as described in the skill's README. Unscoped legacy artifacts cause a refusal and remain untouched. Run state-using commands, including the reaper, in the owning Git clone; an override alone outside Git no longer identifies state.
- Directory identity checks tolerate device-number changes only with matching inode, nonzero directory birth time, canonical target path and a freshly confirmed macOS volume UUID. Snapshot and non-writable views supply no drift proof. Without volume proof, device comparison stays strict. Replaced directories and redirected targets still refuse. Older inherited identity tokens remain strict; re-arm an older driver to establish the stronger baseline.
