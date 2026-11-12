---
release: minor
---

### Added

- The drive reads the findings a review-object reviewer puts only in its
  review's body, never in a thread: CodeRabbit's outside-diff, nitpick,
  duplicate and follow-up comments. Each is a summary-only finding, listed by
  `summary-findings.ts` and answered with `answer-summary-finding.ts`, so a
  drive no longer converges with one unread. Every CodeRabbit nitpick now
  needs an answer before the drive converges, so expect a round to answer
  them. Every review on the pull request is read, since a later review does
  not repeat an earlier one's entries. An entry Jig cannot read (a section
  that declares more entries, or an entry id no entry read took) is reported
  as a finding to answer. Only a format a built-in reviewer profile names is
  read; CodeRabbit's is the first.
