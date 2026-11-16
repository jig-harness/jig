---
release: patch
---

### Fixed

- The audit now flags comment-only scheduled issue sweeps that omit `--position <file>`, explaining that issues past the read cap are never reached; a sweep that passes the flag certifies as before.
