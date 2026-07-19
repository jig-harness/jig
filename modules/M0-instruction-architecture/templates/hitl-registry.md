<!--
  TEMPLATE — copy this file into your repo (e.g. docs/hitl-registry.md),
  replace the example rows with your project's actual human checkpoints,
  and point your universal instruction file at it. Shared concern with
  module M7 (PR lifecycle & review), which covers the PR-stage rows in
  workflow form.
-->

# HITL decision registry

HITL (human-in-the-loop — see the project glossary) decisions are the
classes of decision that must **always be made by a human**, never
autonomously by an agent. Without one canonical list, the boundary lives
scattered across individual rules and skill clauses, and each new
automation re-derives (or misses) it.

Autonomy is the **default** — an agent runs a normal task end to end
(author → quality gates → commit → push → draft PR) without pausing. The
classes below are the deliberate *exceptions*: the decisions the
automation hands back to a person. This registry is the **single source of
truth for the human-checkpoint set**; the actual enforcement lives in the
places each row names.

## Enforcement rungs

Each class names the rung at which the boundary is currently held:

- **Mechanical** — a system prevents the automation from crossing the line
  (branch protection, required status checks, a manual-trigger-only
  workflow). The rule cannot be forgotten.
- **Semi-mechanical** — a gate *reminds* at the right moment (a mandatory
  checklist prompt inside a review step), but the sign-off itself is still
  a human convention.
- **Convention-only** — the boundary is documented and honored by
  discipline, but nothing mechanically stops an agent from crossing it.
  These are the future-mechanization candidates — mark them ⚙️ so the gap
  stays visible.

## Registry

<!-- Example rows below are common across projects — keep, adapt, or
     replace. Every row needs: why it stays human (irreversibility, cost,
     judgment, accountability) and where the boundary is enforced today. -->

| # | Decision class | Why it stays human | Where enforced today | Rung |
|---|----------------|--------------------|----------------------|------|
| 1 | **Mark a PR ready for review** | Decides the PR is worth the expensive review layers and reviewers' attention. Judgment + cost. | <git-workflow rule / instruction file — agents drive up to this line and stop> | ⚙️ Convention-only |
| 2 | **Merge a PR** | The irreversible landing decision — ships to shared branches. Irreversibility + accountability. | <branch protection + required checks (mechanical); the merge click is human> | Mechanical + convention |
| 3 | **Production deploys & destructive/irreversible ops** | Highest blast radius: prod data mutation, destructive migration, secret rotation. Irreversibility + accountability. | <manual-trigger-only workflow; deployment environment with required reviewers if configured> | ⚙️ Convention-only unless environment approval is configured |
| 4 | **Changing what automation can block or veto** | Flipping a reviewer or gate from advisory to blocking changes what the automation can stop a human from shipping. Judgment + accountability. | <documented posture near the gate config; CODEOWNERS on that config if mechanized> | ⚙️ Convention-only |
| 5 | **Changes to the agent instructions themselves** | Editing instruction files, rules, or skills alters how *every future agent* behaves — the highest-leverage edit in the repo. Judgment + blast radius. | <"never auto-apply" clause in the reflection/feedback workflow; CODEOWNERS if mechanized> | ⚙️ Convention-only |
| 6 | **Scope expansion beyond a task's stated boundaries** | Silently widening a PR removes the human's implement-now-or-defer call and inflates review burden. Judgment + accountability. | <instruction-file clause: flag scope-ballooning feedback instead of silently implementing> | ⚙️ Convention-only |
| 7 | **Customer-facing copy & legal sign-offs** | External-facing correctness and legal accountability. Accountability + judgment. | <required reviewer on the relevant paths; checklist prompt in review steps> | Semi-mechanical |
| 8 | **Bypassing a failing gate** (`--no-verify` and equivalents) | Judging that every remaining failure is genuinely unrelated/systemic needs a human and an audit trail. Judgment + accountability. | <documented bypass protocol: allowed only with a written justification in the PR body + a follow-up issue; CI re-runs the same gates as required checks> | ⚙️ Convention-only (CI backstop is mechanical) |

## Convention-only entries — mechanization candidates

The ⚙️-marked rows are held by discipline, not by a system. Each is a
candidate for converting the convention into a gate (see module M1's
enforcement ladder). Mechanizing them is out of scope for this registry —
the registry only *names* the gap so it stays visible. Typical moves:

- A deployment **environment with required reviewers** turns a
  manual-trigger deploy from convention into a real approval gate (row 3).
- A **CODEOWNERS entry** on gate config and instruction-file paths gates
  rows 4–5 on human review.
- A bot that **requires the bypass-justification section** in the PR body
  whenever a push skipped local hooks backstops row 8.

## Related

- Per-task opt-out: a `hitl` label on an issue marks work whose deliverable
  *is* human judgment (spikes, designs, decision records) — it revokes the
  default autonomous run for that one task without touching this registry.
- Module M7 — PR lifecycle & review (the PR-stage rows in workflow form).
