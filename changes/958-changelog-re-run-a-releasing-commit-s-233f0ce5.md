---
release: patch
---

### Fixed

- Release tagging retries failed required checks once before leaving a release untagged; configure `changelog.release.rerun_failed_gates` to change the budget or set it to `0` to disable retries.
- The tag plan and release status keep reporting every untagged release even after a newer version is tagged. Older releases remain listed for manual tagging without triggering retries or holding newer tags back.
