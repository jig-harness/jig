---
release: minor
---

### Fixed

- A drive whose forge reads met the credential's spent rate limit no longer ends `INDETERMINATE` (exit `1`) for a person to read and re-arm. The attach and the status probe read the limit's reset from the outbound layer: a reset within `DRIVE_PR_RATE_LIMIT_WAIT` seconds (30 minutes by default) is waited for, sending nothing before it, and the drive goes on; one further off stops it with the new state [`FORGE_RATE_LIMITED`](../plugin/protocol/drive-exits.md) (exit `24`), whose report and closing report name the reset, cause `environment`, the line as the owner of the next step. `jig dispatch` re-drives that stop after the reset its stop recorded, without a person, and `jig ask` names the state and the reset.
