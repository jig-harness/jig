---
release: minor
---

### Added

- **Implementation guidance in `do-item`.** `do_item.guidance` lists skills
  and notes by issue label and path, in the shape of `do_item.gates`, and a
  change area's new `implementation: { skills, notes }` adds the same per
  area. `determine_agent.ts` prints the union of what matches, with the
  matched areas' own notes, and `do-item` hands it to the implementing agent
  under `## Implementation guidance`. A guidance skill that resolves to
  nothing installed is named in the status message, and `/jig:audit`
  refuses it.
- **Issue labels and reviewers on the pull request.**
  `pull_requests.labels_from_issue` and `pull_requests.reviewers_from_issue`
  map the issue's labels, in any case, to pull-request labels and to
  reviewers (logins or `org/team`); a change area's new
  `pr: { labels, reviewers }` does the same for the pull requests that touch
  it. `pr-plan.ts open --issue-json <file>` adds them to the plan, shows
  where each came from, and stops naming a mapped label the repository does
  not have; the audit reports a missing `labels_from_issue` label too.
  Reviewers requested on a draft are notified once it is marked Ready.
