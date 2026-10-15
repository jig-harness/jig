---
release: minor
---

### Fixed

- Reflection no longer attaches a finding to another owner's class issue. The
  `pattern:<class>` label is shared by every repository filing into the same
  tracker team, so two repositories reviewing the same class used to land on the
  first one's issue. The `plan` of `/jig:reflect` and `/jig:review-reflections`
  now carries an `owner_marker` (`Jig owner: <owner>`, the owner
  percent-encoded): the issue filed for a
  class must carry it as a line of its own in the description, and the lookup
  attaches only to open issues that carry the asking owner's marker. A class
  issue filed before this change has no marker and is not attached to: the next
  escalation files a new one. The tracker port's `labelledIssues` can now return
  descriptions, and refuses an issue whose requested description is missing or
  neither a string nor an explicit null, rather than reading it as unmarked; an
  explicit null is an empty description and so carries no marker.
