---
release: minor
---

### Added

- A pickup's decision on a Linear or Jira item is answered on the item
  itself: the dispatcher's tick reads the item's comments under the same
  rules as a pull request's (an answer counts only from a member of the
  tracker's workspace who is not a guest, never from the user the
  dispatcher's tracker credential acts as, and only when it names the
  decision's current digest and every person's latest answer chooses the
  same option), and `jig send pickup@owner/name#KEY answer pickup --approve
  --decision <digest>` writes that answer on the item as the user the
  tracker's credential acts as on your machine, refusing when that user is
  the repository's factory identity. The tracker interface's comment facts
  now name each comment's author, its link and its last edit on the Linear,
  Jira and GitHub adapters, read in the request that already reads the
  comments; a tracker whose adapter cannot name an author is not read, and
  the need says why.
