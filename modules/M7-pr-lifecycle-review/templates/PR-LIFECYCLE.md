# PR lifecycle

> TEMPLATE — copy to your repo (e.g. `docs/development/pr-lifecycle.md`) and
> adjust the forge-specific steps (the `<...>` bits). This is the narrative
> contract for how a change moves from branch to merged; the executable steps
> (skills, gates, bots) are referenced, not restated.
>
> **On copying, repoint every link.** The links below are written relative to this
> file's home in the groundwork module (`../reference/...`, `../../M8-...`) so they
> resolve while you are reading it here. At the destination above they would
> resolve to `docs/reference/...`, which does not exist. Point each one at wherever
> you vendored the module — the same path you set `M7` to in your CI wiring — or at
> your own copy of the gate, or delete it if you did not adopt that piece. A dead
> link in the contract everyone is told to read is how a gate quietly stops being
> the thing people follow.
>
> Invariant it encodes:
> **PRs open as drafts; a human marks Ready and a human merges; every review
> thread ends resolved with an audit trail, in a terminal state the author
> declares rather than one anybody infers later; and review is a loop over
> rounds whose stop condition is a round that finds nothing left.**

## The loop

```
branch → open DRAFT PR → self-review → CI + automated review + human review
      → resolve-comments loop, one ROUND per push:
            resolve every thread → push → reviewers re-run → repeat
            until a round is settled with nothing left  (not merely "nothing open")
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
There are exactly four, the set is **closed** (an unrecognised state fails rather
than passing), and each leaves an audit trail:

| Outcome | What it means | Trail required |
|---------|---------------|----------------|
| **Addressed** | accepted and fixed here | the commit / change that fixes it, linked in the thread; then resolve |
| **Rejected** | the finding is wrong or the behaviour is intended | a stated reason in the thread; then resolve |
| **Deferred** | accepted, but not fixed here | the follow-up item it was filed as, with its id; then resolve |
| **Moot** | no longer applies — the code it anchored to is gone | the commit / change that superseded it; then resolve |

**Moot is not a polite Rejected.** Rejected asserts the reviewer was *wrong*;
moot asserts it may have been *right about code that no longer exists*. Collapsing
them tells a learning loop ([M8](../../M8-learning-loop/)) that the reviewer
produced a false positive when it did not, which trains away findings it got
right. Three of the four states claim that some change exists — "fixed here",
"tracked there", "superseded by that" — so for those, prose is not a trail: name
the commit, the follow-up id, or the URL.

**Declare the state; do not leave it to be inferred.** Write it in the reply, in
whatever anchored form your repo picked (`<...>` — a leading token, or a trailing
`Verdict:` line), at the moment you reply. Reconstructing verdicts from prose
afterwards loses acceptances far more often than rejections, which quietly biases
anything downstream that counts them. If a reply is genuinely *not* a verdict — a
clarifying question mid-thread — say so explicitly rather than inventing a state;
"cannot tell" is a real outcome and must not be rounded to a real one.

Two things are **not** an agent's call and stop for a human
([HITL](#human-in-the-loop-boundaries)):

- **Scope expansion.** If addressing a comment means changing something outside
  the PR's stated scope, do not silently widen it — flag it and ask.
- **Overruling a human.** An agent may not resolve a *human* reviewer's thread
  by rejection on its own judgment; a human decides.

#### Knowing when the loop is done

Resolving a round means pushing, and pushing re-triggers the reviewers, so
"zero open threads" is **not** the stop condition. Two rules, and both failures
are silent — no error is raised either way:

- **Zero open threads while a reviewer is still running is not convergence.**
  That round's comments have not posted yet; stopping there abandons live
  findings and looks exactly like success.
- **Re-check that the PR is still open, every round.** A merge or close that
  lands mid-loop orphans every later fix onto a branch nothing will merge.

**Exit:** a round in which every thread is Addressed / Rejected / Deferred / Moot
with its trail, every reviewer has reported, and the PR is still open.
**Executable:** the unresolved-threads merge gate
[`check-threads-resolved.sh`](../reference/comment-resolution/) — fed by the
verdict export adapter, not by raw reply text — and the per-round
[convergence check](../reference/review-convergence/), whose exit code drives the
loop. Both are wired in [`mappings.md`](../mappings.md).

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

A change that took **many rounds** to converge is itself a signal: usually the
scaffolding under-served it, not that the reviewer was noisy. Feed the round count
to the learning loop rather than letting it evaporate with the session — see
[M8](../../M8-learning-loop/)'s
[reflection trigger](../../M8-learning-loop/reference/reflection-trigger/).

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
