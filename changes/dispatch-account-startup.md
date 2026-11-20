---
release: minor
---

### Fixed

- The dispatcher backs off an account when the vendor refuses its sign-in,
  shows one sign-in request for the account, and lets another available
  account retry the work. Repeated startup failures also trigger account
  backoff so a recurring problem stops consuming new work.
