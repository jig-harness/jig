---
release: patch
---

### Fixed

- Jira and GitHub tracker reads retry HTTP 429 and 503 responses up to three times, respecting Retry-After, cancellation and the original call deadline. Read-only searches can retry; writes never do. Credential rate-limit holds continue to prevent requests before their reset.
- GitHub tracker reads correctly parse headerless responses emitted with mixed line endings by the GitHub CLI.
