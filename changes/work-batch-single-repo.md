---
release: patch
---

### Fixed

- `/jig:work-batch` no longer holds back an issue for lacking the repository
  label (`review.repo_label`) when the tracker is one GitHub repository's and
  `review.taxonomy.repos` names no repository besides that label. Every issue
  in such a tracker belongs to the repository, so a missing label said
  nothing, and the filers that do not add it (issue forms, `/jig:file-issue`)
  left their issues out of every batch. A tracker that holds several
  repositories' issues, and the Linear and Jira adapters, keep the check. The
  eligibility report's policy shows `repoLabel: null` (not checked) then.
