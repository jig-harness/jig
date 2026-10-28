---
release: patch
---

### Fixed

- The replied-thread sweep and `triage-thread.ts` keep declined code-scanning findings open until their alerts are confirmed dismissed, and a plain `moot` open until its alert is fixed, closed or dismissed; `triage-thread.ts` exits `4` while one is not.
