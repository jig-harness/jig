---
release: patch
---

### Fixed

- The Jira token command's renewal is now covered by tests: after a renewed
  token is refused the adapter stops running the command, and it renews again
  once a renewed token has been accepted and later refused.
