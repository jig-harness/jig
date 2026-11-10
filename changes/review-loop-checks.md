---
release: patch
---

### Fixed

- Review passes disable background tasks in Claude Code and report unfinished held fixes before another round is spent.
- The standalone review loop waits for the configured reviewer's evidence on the current head before reporting convergence.
- Accepted findings require a recorded triage-ladder verdict for their round, and thread resolution requires a later reply from the resolving login.
- Code-scanning severity metrics read the linked alert, support repository-specific mappings and keep unreadable alerts unknown.
