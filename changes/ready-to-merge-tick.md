---
release: minor
---

### Added

- `jig dispatch` places every converged pull request in **Ready to merge**
  at each tick: **merge now**, with a `gh pr merge` command pinned to the
  head the drive verified and built only from values of a strict form;
  **approve first**, naming the reviewers asked, or that nobody is, and
  saying the repository's other protection rules are not read; or **update
  next**, one pull request per repository behind its base. One that fails a
  condition is placed where its reason says, with the act that settles it.
  Merge now never rests on the drive's ledger alone: the forge must witness
  a review of the head (the `review.reviewer_app` check run, or a person's
  approval where no app is named), and a pull request from outside the
  repository needs a person's approval. The facts come from a board read of
  its own in the tick's observe phase, under a 30-second deadline and a
  floor on the forge's budget; a board read that fails changes nothing the
  tick launches. The receipt carries it as `board`, the dashboard's line as
  `ready`, and a pull request entering merge now or approve first is
  notified once per head (cause `ready`).

### Changed

- `announce-merge-ready.ts` asks the same predicate on top of its own gates:
  it refuses a head the forge does not witness a review of, and words
  approve first as "an approval is still required", updating that warning
  when a standing announcement's lane changes at the same head.
- `jig ask` names a converged drive's lane and act (merge now with its
  pinned command, approve first, update next, or what settles it) in place
  of saying the approval and the branch were not read. It reads the review
  rules and enabled hold labels from the default branch, including away
  from a checkout, and reports when the repository's update order cannot
  be read. Bounded line lists include counts of omitted cards and checks.
