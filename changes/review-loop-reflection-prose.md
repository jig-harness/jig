---
release: patch
---

Prose fixes to the PR review loop's skills. No configuration changes and no
script changes.

### Changed

- The triage rubric's guardrail on human-decided text also covers a fix that
  adds or changes a normative rule inside such a span while leaving the decided
  value as recorded. An unattended loop that accepted such additions one
  finding at a time extended a decision over several rounds until one addition
  contradicted the recorded amendment. A finding whose fix does this is never
  an ordinary accept: it is parked or escalated, or only wording that leaves
  the rule unchanged is accepted. The review arbiter's `fix-now` restriction
  says the same.
- `/jig:drive-pr` and `/jig:resolve-review-comments` say that `--tier` is the
  finding's rank in the rubric's priorities, taken from the kind of file the
  finding sits on and not from the PR's overall kind. The
  `resolve-review-comments` README states the same rule for human readers.
- `/jig:resolve-review-comments`' pre-reply checks include that each behaviour
  a reply asserts is in the staged diff, and that a temporal claim is tested
  after the boundary it names.
- `/jig:drive-pr` states that a drive likely to outlast the harness's
  background ceiling must start outside the harness, because the harness
  stops the command's whole process group at the ceiling.
- `/jig:drive-pr` tells the agent to close each reply-template heredoc on its
  own delimiter when batching calls (a mismatch posts the next command to the
  PR as the body), to stop and report when the worktree's branch is not the
  PR's head branch instead of renaming or checking out branches, to run each
  emitted plan check as its own command (a `set -e` script skips the checks
  after a failed non-last member of an `&&` list), and to re-read an
  inherited held thread reply against its thread before treating it as settled.
  That re-read comes before `finish-round.ts`, which drains every hold, and a
  mismatch is dispatched through `triage-thread.ts` after the fresh reply;
  `--cleanup-only` stays reserved for a human thread left open. An inherited
  summary-finding hold, which has no posted reply, has its held reason re-read
  against the finding before `finish-round.ts` too. On a mismatch the stale
  hold is released first, because parking leaves it in the held batch and the
  drain would post it, then re-held with the correct reason or parked.
- `/jig:drive-pr` names a separate terminal pane or a new session for a drive
  started outside the harness, because `nohup` alone leaves the command in the
  harness's process group.
- The glossary defines a human-decided span and its normative rules.

