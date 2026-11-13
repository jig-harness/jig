---
release: patch
---

### Fixed

- On Jira, a native priority can now be written with a scoped API token or an
  OAuth access token that the gateway refuses on `priority/search`: the
  adapter reads the site's priorities from `GET priority` instead, so
  `tracker.ts create` and `update` set the priority.
- `tracker.ts facet-stores` and the audit's tracker check now report a Jira
  native priority store that cannot be used, naming the priority and the
  reason: a name the site does not have, or a create screen of an issue type
  Jig files without the priority field or without that value.
- The note about the classic `read:jira-user` scope now appears only when the
  account read (`myself`) is refused for its scope, not on any other request
  refused with `scope does not match`.
