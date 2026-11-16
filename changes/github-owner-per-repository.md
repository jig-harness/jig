---
release: patch
---

### Fixed

- A machine whose `gh` picks the GitHub account per repository from the
  stored logins (a wrapper that chooses the account by the repository a
  command addresses) no longer refuses every repository's GitHub calls when
  one account's rate limit is spent. The stored login's quota owner is now
  asked and kept per repository a call addresses (`-R`, a
  `repos/<owner>/<repo>` route, `GH_REPO`, else the working directory's
  `origin` remote), with `GH_REPO` set for the question: one `GET /user` a
  day for each repository. A rate-limit refusal that names another user
  than the cached owner holds that user's allowance and makes the owner be
  asked again, and a call refused before sending names the account whose
  allowance is spent, as in `(the allowance of GitHub account alice)`.
