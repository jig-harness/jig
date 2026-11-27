---
release: patch
---

A pickup reuses a Scout Findings comment only when its author is trusted.

### Security

- `list_comments.ts` now reports each comment's author login and the
  tracker's association for them (`authorAssociation`: GitHub's own value, a
  workspace member as `MEMBER` on Linear and Jira, `UNKNOWN` when the tracker
  cannot say), and `select_scout_finding.ts` selects a findings comment only
  from an author `shared/trusted-authors.ts` trusts. Any other findings
  comment is listed under `untrusted` in the decision and ignored, so on a
  public repository a comment from anyone else is no longer taken as a
  pickup's plan. `/jig:do-item` reads such comments as data, marked as
  untrusted, and `plugin/MECHANISMS.md` describes the boundary.

### Changed

- A pickup fetches an issue's comments with `list_comments.ts` for its scout
  check even when a launcher cached them, since the cache names no author
  association; a findings comment from the native Linear tool, which names
  none either, is ignored and the scouts run again.
