# PR lifecycle

> TEMPLATE — copy to your repo (e.g. `docs/development/pr-lifecycle.md`) and
> adjust the forge-specific steps (the `<...>` bits). This is the narrative
> contract for how a change moves from branch to merged; the executable steps
> (skills, gates, bots) are referenced, not restated. Invariant it encodes:
> **PRs open as drafts; a human marks Ready and a human merges; every review
> thread ends resolved with an audit trail.**

## The loop

```
branch → open DRAFT PR → self-review → CI + automated review + human review
      → resolve-comments loop (repeat until zero open threads)
      → gates green → mark READY (human) → merge (human) → update tracker
```

Each stage below states its exit condition — you do not advance until it holds.

### 1. Open as a draft

Open the PR in **draft** state as soon as there is something to run against.
Draft means "CI and bots may run; humans need not look yet" — it is the
author's workspace, not a review request. The PR description links its tracked
work item and states what changed and how it was verified.

**Exit:** a draft PR exists; its description names the change and the
verification done.
**Executable:** your forge's draft-PR command — `gh pr create --draft`, or a
GitLab `Draft:` title prefix (per-forge in [`mappings.md`](../mappings.md)).

### 2. Self-review

Before requesting any human, read your own diff end to end. Fix the obvious;
leave inline notes where a reviewer will otherwise ask. Run the local gate set.

**Exit:** the author has reviewed the full diff; local gates pass.
**Executable:** run the local gate set — the M7 gates
([`check-pr-target-safety.sh`](../reference/pr-target-safety/),
[`check-threads-resolved.sh`](../reference/comment-resolution/)) plus your
repo's own gates — and your agent runtime's self-review (e.g. `/review`).

### 3. Automated + human review (concurrent, layered)

Reviewers run in parallel with distinct roles:

| Reviewer | Role | Posture |
|----------|------|---------|
| Automated (in-house harness) | fast, additive lenses; grows via the learning loop | comment-only until its precision bar is cleared |
| Automated (commercial bot) | AST / static-analysis depth | comment-only until it clears the same measured-precision bar |
| Human reviewers | judgment, context, sign-off | authoritative; a "request changes" blocks |

**Which human reviews are mandatory is selected by what changed** — the
change-area catalog's review-gate projection decides (a migration pulls in the
migration reviewer, an API change the API reviewer). Do not rely on memory.

**Exit:** the mandatory reviewer set (per change-area) has been requested and
has responded.
**Executable:** the reviewers registered in
[`review-config.yaml`](review-config.yaml); which humans are mandatory comes
from [M3](../../M3-change-area-catalog/)'s review-gate projection.

### 4. The resolve-comments loop

Every review thread — from a human or a bot — must reach a **terminal state**.
There are exactly three, and each leaves an audit trail:

| Outcome | What it means | Trail required |
|---------|---------------|----------------|
| **Addressed** | fixed in the PR | the commit / change that fixes it, linked in the thread; then resolve the thread |
| **Rejected** | won't fix | a stated reason in the thread; then resolve |
| **Deferred** | fix later | a filed follow-up item (with its id), linked; then resolve |

Repeat the loop — new commits may draw new comments — until **zero threads are
open**. Two things are **not** an agent's call and stop for a human
([HITL](#human-in-the-loop-boundaries)):

- **Scope expansion.** If addressing a comment means changing something outside
  the PR's stated scope, do not silently widen it — flag it and ask.
- **Overruling a human.** An agent may not resolve a *human* reviewer's thread
  by rejection on its own judgment; a human decides.

**Exit:** every thread is Addressed / Rejected / Deferred and resolved; zero
open threads.
**Executable:** the unresolved-threads merge gate
[`check-threads-resolved.sh`](../reference/comment-resolution/), fed by the
thread-state export step in [`mappings.md`](../mappings.md).

### 5. Gates green, then Ready, then merge

With all threads resolved and all required checks green, a **human marks the PR
Ready** and a **human merges**. Both are deliberate human acts — the automated
pipeline never marks Ready or merges on its own. Resolve conflicts against the
base branch before merge; re-run gates if the merge changed the diff.

**Exit:** required checks green, zero open threads, human Ready + human merge.
**Executable:** human-only forge actions (mark Ready, then Merge), enforced by
branch protection requiring a human actor — see the
[HITL registry](HITL-REGISTRY.md).

### 6. Update the tracker

On merge, move the tracked work item to its next state and record anything the
next agent needs (a follow-up filed in step 4, a decision worth an ADR).

**Executable:** your tracker's transition command / task update (see
[M9](../../M9-tasks-memory/)).

## Human-in-the-loop boundaries

These decisions are **human-only** on every PR — never taken autonomously by an
agent. See the [HITL registry](HITL-REGISTRY.md) for the full list and the
rationale:

- Marking a PR **Ready** for review.
- **Merging.**
- **Expanding scope** beyond what the PR set out to do.
- **Overruling a human** reviewer's thread.
- **Promoting an automated reviewer** (or a lens) from comment-only to blocking.

An item carrying the `hitl` label revokes autonomous merge for that PR
entirely. Enforcement is the forge's branch-protection rule that requires a
human actor to merge (no bot/self-merge) — the same rule the [HITL
registry](HITL-REGISTRY.md) names — so the label's effect is mechanical, not
just convention.
