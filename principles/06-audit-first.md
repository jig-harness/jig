# 6 — Audit-first brownfield entry

The natural entry point for an existing project is not "adopt module M0" — it
is **"tell me where I stand."** Groundwork therefore ships as a runnable
assessor ([audit/](../audit/)), not just reference material:

1. **Fan out parallel read-only surveys** over the target repo, one per
   practice area (instruction files, docs governance, automation/enforcement,
   review setup, tasks/memory, environments/CI).
2. **Detect the stack** from observable facts, so recommendations are phrased
   in the target's own tools (principle 1).
3. **Score each module** against its `maturity.yaml` criteria, where the score
   *is* the enforcement-ladder rung: absent → convention-only → mechanically
   enforced (principle 4).
4. **Report**: per-module findings with file-path evidence, a prioritized
   recommendation list (leverage × effort), a suggested adoption sequence, and
   drift findings — contradictions between what the repo *says* it does and
   what it *does* are first-class results.

**Why.** Brownfield teams don't lack ideas; they lack a trustworthy picture of
their own gaps and an ordering. An audit produces both, and re-running it
periodically turns the same machinery into a **practices-drift regression
check** — including on repos that already adopted groundwork.

**Consequences:**

- Every module must keep its maturity criteria observable and scoreable; a
  module the auditor can't score is incomplete.
- The audit's own history matters: the founding audit of the reference
  implementation (2026-07-18) is preserved as the methodology's first run and
  its prompts seed [audit/survey-prompts/](../audit/survey-prompts/).
