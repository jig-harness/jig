# PR lifecycle

> TEMPLATE — copy to your repo (e.g. `docs/development/pr-lifecycle.md`) and
> adjust the forge-specific steps (the `<...>` bits). This is the narrative
> contract for how a change moves from branch through the merge and what the
> merge still owes; the executable steps
> (skills, gates, bots) are referenced, not restated.
>
> **On copying, repoint the links you adopted.** The links below point at
> Jig's own copy of each gate, template and module. Point each one at
> wherever you vendored that piece — the same path you set `M7` to in your CI
> wiring — or at your own copy of the gate, or delete it if you did not adopt
> that piece. A link to a gate you do not run, in the contract everyone is told
> to read, is how a gate quietly stops being the thing people follow.
>
> Invariant it encodes:
> **PRs open as drafts (or Ready, where the repository declares so because
> none of its reviewers reviews drafts); a human, or an adopted review driver at the round the
> repository declares, marks Ready; a human merges; every review
> thread ends resolved with an audit trail, in a terminal state the author
> declares rather than one anybody infers later; review is a loop over
> rounds whose stop condition is a round that finds nothing left; and the
> lifecycle does not stop at the merge: after it, each class of residual
> obligation is settled as owed (filed or done) or not owed (with the
> evidence).**

## The loop

```
branch → open DRAFT PR → self-review → CI + automated review + human review
      → resolve-comments loop, one ROUND per push:
            resolve every thread → push → reviewers re-run → repeat
            once the draft reviewers settle: mark READY (human, or a review driver)
            until a round after READY is settled with nothing left
            (not merely "nothing open")
      → gates green → merge (human)
      → settle what the merge still owes: each class owed (filed or done)
        or not owed (with evidence)
```

Each stage below states its exit condition — you do not advance until it holds.

### 1. Open as a draft

Open the PR in **draft** state as soon as there is something to run against.
Draft means "CI and bots may run; humans need not look yet" — it is the
author's workspace, not a review request. The PR description links its tracked
work item and states what changed and how it was verified.

If none of your reviewers reviews drafts, a draft only delays the first
review; such a repository may declare that PRs open Ready, which starts the
loop already past [Ready happens inside the loop](#ready-happens-inside-the-loop).

**Exit:** a draft PR exists (or a Ready one, where declared); its description
names the change and the verification done.
**Executable:** your forge's draft-PR command — `gh pr create --draft`, or a
GitLab `Draft:` title prefix (per-forge in [`mappings.md`](https://github.com/docomply/jig/blob/main/modules/M7-pr-lifecycle-review/mappings.md)).

### 2. Self-review

Before requesting any human, read your own diff end to end. Fix the obvious;
leave inline notes where a reviewer will otherwise ask. Run the local gate set.

**Exit:** the author has reviewed the full diff; local gates pass.
**Executable:** run the local gate set — the M7 gates
([`check-pr-target-safety.ts`](https://github.com/docomply/jig/tree/main/modules/M7-pr-lifecycle-review/reference/pr-target-safety),
[`check-threads-resolved.ts`](https://github.com/docomply/jig/tree/main/modules/M7-pr-lifecycle-review/reference/comment-resolution)) plus your
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
every reviewer that reviews drafts has responded. The rest respond only once
the PR is Ready, which happens inside step 4.
**Executable:** the reviewers registered in
[`review-config.yaml`](https://github.com/docomply/jig/blob/main/modules/M7-pr-lifecycle-review/templates/review-config.yaml); which humans are mandatory comes
from [M3](https://github.com/docomply/jig/tree/main/modules/M3-change-area-catalog)'s review-gate projection.

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
them tells a learning loop ([M8](https://github.com/docomply/jig/tree/main/modules/M8-learning-loop)) that the reviewer
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

#### Ready happens inside the loop

Reviewers fall into two sets: those that review drafts, and those that respond
only once the PR is Ready — review bots that skip drafts, and human reviewers
who wait for the Ready signal. Once a round has settled with every
draft-reviewing reviewer, the PR is marked **Ready**: by a human, or, where the
repository adopts an unattended review driver, by that driver at the point
the repository declares: after a given review round, or only once the
draft-reviewing reviewers have nothing left. Either way, the reviewers that skip drafts then
spend their pass on a head the draft reviewers have already cleaned.

From Ready on, the loop waits on both sets: a round counts as settled only when
every reviewer, the ones Ready summoned included, has reported on the current
head. A driver whose convergence covered only the draft-reviewing reviewers has
not finished this step; run the loop again once the newly summoned reviewers
settle.

#### Knowing when the loop is done

Resolving a round means pushing, and pushing re-triggers the reviewers, so
"zero open threads" is **not** the stop condition. Two rules, and both failures
are silent — no error is raised either way:

- **Zero open threads while a reviewer is still running is not convergence.**
  That round's comments have not posted yet; stopping there abandons live
  findings and looks exactly like success.
- **Re-check that the PR is still open, every round.** A merge or close that
  lands mid-loop orphans every later fix onto a branch nothing will merge.

**Exit:** the PR is Ready, and a round after Ready in which every thread is
Addressed / Rejected / Deferred / Moot with its trail, every reviewer in both
sets has reported, and the PR is still open.
**Executable:** the unresolved-threads merge gate
[`check-threads-resolved.ts`](https://github.com/docomply/jig/tree/main/modules/M7-pr-lifecycle-review/reference/comment-resolution) — fed by the
verdict export adapter, not by raw reply text — and the per-round
[convergence check](https://github.com/docomply/jig/tree/main/modules/M7-pr-lifecycle-review/reference/review-convergence), whose exit code drives the
loop. Both are wired in [`mappings.md`](https://github.com/docomply/jig/blob/main/modules/M7-pr-lifecycle-review/mappings.md).
With Jig's plugin, `/jig:resolve-review-comments` runs one pass of
this loop and `/jig:drive-pr` runs its rounds unattended
([plugin](https://github.com/docomply/jig/blob/main/plugin/README.md)).

### 5. Gates green, then merge

With the PR Ready, all threads resolved and all required checks green, a
**human merges**. The merge is always a deliberate human act — the automated
pipeline never merges on its own. Resolve conflicts against the base branch before merge; re-run gates
if the merge changed the diff.

**Exit:** required checks green, zero open threads, human merge.
**Executable:** the merge is a human-only forge action, enforced by branch
protection requiring a human actor — see the [HITL registry](https://github.com/docomply/jig/blob/main/modules/M7-pr-lifecycle-review/templates/HITL-REGISTRY.md).

### 6. After the merge: what does the merge still owe?

Merging closes the pull request, not the work. A merge can leave a tracker
item in the wrong state, a deferred finding that was never filed, an action
outside the repository nobody wrote down, a widened timeout or a running
driver nobody turned back, a change nobody has seen run, and no decision about
what comes next. Nothing else looks for these after the merge, so this stage
does: one pass, run by the session that drove the pull request while the
facts are still in its context, by a person, or by a scheduled job.

Each class ends in exactly one of two states, and "nothing found" is neither:

- **Owed**: the obligation exists and is filed (an item, with its id) or done
  (with what was done).
- **Not owed**: the obligation does not exist, with the evidence that settled
  it. "No file under `src/` changed" is evidence; "I saw nothing" is not.

| Class | Settled when | Not owed, for example |
|-------|--------------|-----------------------|
| **Tracker state** | The item's own state follows the merge (done, or waiting while a manual, operational or legal step remains), and the epic above it has been rolled up from its children. An epic closes only as [M9](https://github.com/docomply/jig/blob/main/modules/M9-tasks-memory/README.md#an-epic-closes-on-an-accepted-verdict) says, never on the merge | The pull request names no tracked item |
| **Deferred findings** | Every `deferred` reply produced a tracked item that exists. Re-list the resolved threads, because a deferred thread resolves the moment its reply posts, and the summary findings, which have no thread: a reply that says "deferred" proves only that someone typed it | The re-listed threads and summary findings hold no deferred outcome |
| **Out-of-tree obligations** | Every action the merge leaves outside the repository (a secret or setting to provision, a manual rollout, a migration run by hand, an announcement) is listed when the pull request opens, with an explicit "None" when there are none, and is recorded where a person will find it: the tracker item's closing comment, and the repository's own ledger of such work where it keeps one | The list reads "None", and the diff touches no workflow, configuration or migration |
| **Temporary scaffolding** | Whatever the work put in place to get here is gone, in the repository and outside it: a widened timeout, a disabled or skipped gate, a live review driver, a working branch, a preview environment, a flipped flag | The pull request description and the driver's log name no scaffolding, and no branch, environment or driver of this work is left |
| **Live verification** | The change was seen working, but only when it has a runtime surface, has reached an environment, and is not already covered by CI. Owed means run it and record what it showed | The change is documentation only, or no environment has it yet, or a named CI job exercises it |
| **Next step** | The next item is picked, with a bias toward closure (below) | No open work remains, shown by the tracker's open-item list; never "not owed" in a repository that has open work; the pick itself is a [human decision](#human-in-the-loop-boundaries) |

**Picking the next step.** In order: finish a nearly-done epic first, since
closing one removes a whole line from the board; otherwise clear the
operations that can be cleared now (a step waiting only on a person who is
here, a drill, a sign-off); otherwise take a batch of small items together
([batching small issues into one pull request](https://github.com/docomply/jig/blob/main/ROADMAP.md#13-batching-small-issues-into-one-pull-request-work-batch)).
A computed ranking proposes the shortlist; a person picks from it.

Fixes the pass finds go in one follow-up pull request, not one each. Run
before the merge, the same pass lists what the merge will owe, and carries out
nothing.

**Exit:** every class above is recorded as owed (with the item or what was
done) or not owed (with the evidence), and the next item is picked, or the
evidence that no open work remains is recorded.
**Executable:** `do-item`'s post-merge status rule moves the item's state, and
its [Step 5a](https://github.com/docomply/jig/blob/main/plugin/skills/do-item/SKILL.md#step-5a-all-sub-issues-complete)
rolls the epic up: `reconcile_parent_status.ts` proposes the epic's state from
its children, and Step 5a applies it only after the acceptance and closing
checks; the
[deferral protocol](https://github.com/docomply/jig/blob/main/plugin/skills/resolve-review-comments/references/deferral-protocol.md)
files what a deferred reply left unfiled. The
[unresolved-threads gate](https://github.com/docomply/jig/tree/main/modules/M7-pr-lifecycle-review/reference/comment-resolution)
checks before the merge that a deferred reply names a reference, not that the
referenced item exists; only this stage, which can reach the tracker, checks
that. See [M9](https://github.com/docomply/jig/tree/main/modules/M9-tasks-memory)
for the tracker.

A change that took **many rounds** to converge is itself a signal: usually the
scaffolding under-served it, not that the reviewer was noisy. Feed the round count
to the learning loop rather than letting it evaporate with the session — see
[M8](https://github.com/docomply/jig/tree/main/modules/M8-learning-loop)'s
[reflection trigger](https://github.com/docomply/jig/tree/main/modules/M8-learning-loop/reference/reflection-trigger).

## Human-in-the-loop boundaries

These decisions are **human-only** on every PR — never taken autonomously by an
agent. See the [HITL registry](https://github.com/docomply/jig/blob/main/modules/M7-pr-lifecycle-review/templates/HITL-REGISTRY.md) for the full list and the
rationale:

- Marking a PR **Ready** for review — unless the repository delegates it to an
  adopted review driver (step 4), which is then the only automation that may
  take it.
- **Merging.**
- **Expanding scope** beyond what the PR set out to do.
- **Overruling a human** reviewer's thread.
- **Promoting an automated reviewer** (or a lens) from comment-only to blocking.
- **Picking the next item** from the computed ranking (step 6).
- **Reopening on a rejecting verdict, or waiving a missing acceptance
  review.** The approver is someone other than whoever runs the post-merge
  pass or the epic-closing step that found the gap.

An item carrying the `hitl` label revokes autonomous merge for that PR
entirely. Enforcement is the forge's branch-protection rule that requires a
human actor to merge (no bot/self-merge) — the same rule the [HITL
registry](https://github.com/docomply/jig/blob/main/modules/M7-pr-lifecycle-review/templates/HITL-REGISTRY.md) names — so the label's effect is mechanical, not
just convention.
