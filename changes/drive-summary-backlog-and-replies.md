---
release: patch
---

### Fixed

- Drive-pr reports explicitly non-blocking wind-down backlog without
  requiring answers before convergence. Each round groups its blocking
  summary-finding answers into one pull request comment and keeps a
  fingerprint marker per finding so retries can skip delivered answers.
