---
release: minor
---

### Fixed

- A GitHub login is now held to GitHub's own form wherever Jig checks one
  (`isGithubLogin`, a requested reviewer, `dispatch.person` and a parked
  question's person): at most 39 characters in all, an Enterprise Managed
  User's short code included, and no leading, trailing or doubled hyphen.
  Before, a 39-character handle plus a short code passed, as did `mona-`
  and `mona--lisa`. The dispatch dashboard's page now counts
  `plugin/shared/forge-logins.ts` among its sources, so a change to the
  check alone marks the built page stale.
- **Breaking:** The [hidden comment markers](../plugin/protocol/comment-markers.md)
  protocol is now version 3. Its drive-ledger schema narrows a parked
  question's person to the bounded login form above; a reader that loads
  the version 2 schema by its address must load version 3.
  **Consumer action:** advised at machine. A reader that validates drive
  ledgers against the published schema loads it from version 3.
