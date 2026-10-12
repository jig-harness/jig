# 6 — Audit-first brownfield entry

The natural entry point for an existing project is not "adopt module M0" — it
is **"tell me where I stand."** Jig therefore ships as a runnable
assessor (the [audit skill](../plugin/skills/audit/README.md), `/jig:audit`), not
just reference material:

1. **Fan out parallel read-only surveys** over the target repo, one per
   practice area (agent scaffolding, docs governance, automation and
   enforcement, review and learning loop; tasks, memory, environments and CI
   are covered inside the last two).
2. **Detect the stack** from observable facts, so recommendations are phrased
   in the target's own tools (principle 1).
3. **Score each module** against its maturity criteria, where the score
   *is* the enforcement-ladder rung: absent → convention-only → mechanically
   enforced (principle 4).
4. **Report**: per-module findings with file-path evidence, a prioritized
   recommendation list (leverage × effort), a suggested adoption sequence, and
   drift findings — contradictions between what the repo *says* it does and
   what it *does* are first-class results.

**Why.** Brownfield teams don't lack ideas; they lack a trustworthy picture of
their own gaps and an ordering. An audit produces both, and re-running it
periodically turns the same machinery into a **practices-drift regression
check** — including on repos that already adopted jig. Each run is recorded
in the audited repository, so the next one reports what was fixed, what
regressed and what Jig added since, and does not repeat what the team
declined.

**Consequences:**

- Every module must keep its maturity criteria observable and scoreable; a
  module the auditor can't score is incomplete.
- The audit learns from its own runs: each run that exposes a gap in the
  method updates the [survey prompts](../plugin/skills/audit/references/survey-prompts/)
  and the methodology, and the run is kept as a worked example under the
  skill's [calibration/](../plugin/skills/audit/calibration/).
