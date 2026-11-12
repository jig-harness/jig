---
release: minor
---

### Added

- Every tracker value map takes a list of names per value, read in any of
  them and written as the first; a plain name keeps its meaning. A Jira site
  with more priorities than Jig's four reads each as one of them
  (`issue_tracker.jira.priorities: { urgent: [Blocker, Critical, Highest] }`),
  a closed state reads from any of its resolutions
  (`issue_tracker.jira.resolutions: { canceled: ["Won't Do", "Won't Fix"] }`),
  and a type, priority or size kept in issue types, fields or labels reads
  from several (`issue_tracker.facets.type.values: { feature: [Story, Improvement] }`),
  as do `issue_tracker.github.priority_labels`. A name listed for two values
  is refused when the configuration is read
  ([CONFIGURATION.md](../plugin/CONFIGURATION.md#issue_tracker)).
