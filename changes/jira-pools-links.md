---
release: minor
---

### Added

- **Jira: pools limited to issue types.** `issue_tracker.jira.pool_issue_types`
  (such as `[Task, Bug]`) limits every candidate pool and population the Jira
  adapter reads (the pools `work-batch`, `jig dispatch` and the queues pick
  from, the issues assigned to an identity, and the open population the facet
  census and `file-issue`'s sweep count) to those issue types, so a team that
  shares a large project with other lanes reads only its own items. Reads by
  key and an issue's children are not limited. A type the project lacks is
  refused the first time the site is read, `tracker.ts reach` and the audit's
  tracker check included. Unset, every type is read as before.
- **Jira: several link types per relation.** Each relation in
  `issue_tracker.jira.link_types` may name a list of link types, each a name or
  `{ name, inverted }`, such as `blocks: [Blocks, { name: "Depends", inverted:
  true }]`, for a site whose planning app records dependencies on a link type
  of its own. Every listed type is read and each edge reported once; a new
  link is written with the first; `inverted: true` reads a type whose outward
  side means "is blocked by". Every name is resolved against the site's link
  types and refused when it matches none or several, and a name may appear
  only once across the relations. A plain name keeps its meaning.
