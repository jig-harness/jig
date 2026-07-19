# M7 — PR lifecycle & review (stub)

**What problem this solves.** Review quality is uneven and review *process* is
tribal: who reviews what, when a PR is "ready," what happens to bot findings,
who may merge. With AI reviewers added, an unmanaged setup produces noise
instead of safety. This module codifies the draft→review→resolve→merge loop
with layered reviewers and measured automation.

**Invariant.** PRs open as drafts; a human marks Ready and merges (HITL);
mandatory review steps are selected by what changed (M3); every review
comment ends resolved with an audit trail (fixed with reference, or rejected
with a reason); automated reviewers run comment-only until measured precision
justifies more; review feedback loops converge to zero unresolved threads
before merge.

**Port sources**: docomply `docs/development/pr-lifecycle.md` (C2),
`docs/development/hitl-decision-registry.md` (C6), the resolve-review-comments
skill + GraphQL scripts, the shadow-reviewer harness core (repo-agnostic tool
registry, config schema, `pull_request_target` security pattern). Ports in
Phase 4.

**Status**: stub.
