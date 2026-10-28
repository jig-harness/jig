# M7 — PR lifecycle & review

**What problem this solves.** Two things go wrong without a codified review
process. First, the *process* is tribal: who reviews what, when a pull request
([PR](../../GLOSSARY.md)) is "ready," what happens to a bot's finding, and who
may merge all live in people's heads, so they happen inconsistently or not at
all. Second, adding AI reviewers to that vacuum makes it *worse* — an
automated reviewer with no measured precision and the power to block turns
review into noise, and one wired carelessly into CI becomes a security hole (a
reviewer that runs untrusted code from a fork with repository secrets, or lets
the PR being reviewed alter the reviewer's own prompts and policy). This module
codifies the draft→review→resolve→merge loop with layered reviewers, measured
automation, and the human checkpoints kept explicit.

## Invariant

> PRs open as **drafts**, unless the repository declares that they open
> Ready because none of its reviewers reviews drafts; Ready is marked by a human, or by an unattended
> review driver the repository adopts, at the review round (or the
> convergence) the repository declares; a human merges ([HITL](../../GLOSSARY.md)). **How a PR is shaped is declared
> policy, not an agent's improvisation**: its base, whether it may
> [stack](../../GLOSSARY.md) on another PR, its branch name and its size; and
> every PR's final integration target is resolvable by tooling, from its base
> or from stack metadata. The **mandatory review steps are selected by
> what changed** (via the [M3](../M3-change-area-catalog/) change-area
> catalog), not by reviewer memory. Every review comment ends **resolved with
> an audit trail** — in one of a **closed set of terminal states, declared by
> the author rather than inferred from prose** — before merge. Review is a
> **loop over [rounds](../../GLOSSARY.md)**, and its stop condition is a round
> that finds nothing left, not a single pass. **The lifecycle does not stop at
> the merge**: after it, each class of residual obligation (the tracker
> state, deferred findings, out-of-tree actions, temporary scaffolding, live
> verification, the next step) is settled as **owed**, and filed or done, or
> as **not owed**, with the evidence that settled it; "nothing found" is not
> evidence. **Automated reviewers run
> comment-only** until measured precision clears a pre-committed bar that
> justifies more. And any
> reviewer that executes PR code runs it under a **fork-safe** wiring that
> never grants untrusted code access to secrets. The reviewer runtime, prompts,
> and active policy come from a pinned external source, a separately hosted
> service, or the target base branch — never from the PR head being reviewed.

Everything below is one tool-independent statement made mechanical; concrete
per-forge, per-bot wiring lives in [mappings.md](mappings.md).

## Core pieces

1. **Draft-first lifecycle** — a PR opens as a [draft PR](../../GLOSSARY.md) so
   CI and bots run while the author still owns it; marking it **Ready** is a
   deliberate human act unless the repository delegates it to an adopted
   review driver, and the **merge** is always a human act. A repository whose
   reviewers all skip drafts may declare that PRs open Ready instead, since
   there a draft only delays the first review. The narrative contract —
   open draft → self-review → automated + human review → resolve loops (Ready
   once the draft reviewers settle, then the rest review) → gates green →
   merge → tracker update — is the copyable
   [`PR-LIFECYCLE.md`](templates/PR-LIFECYCLE.md).
2. **Change-area-selected reviews** — *which* mandatory reviews a PR needs is a
   generated projection of the [M3](../M3-change-area-catalog/) catalog (a
   migration touches the migration review; an API change touches the API
   review), not a reviewer's recall. The review-gate table is one of M3's
   projections; M7 consumes it.
3. **Layered reviewers, one harness shape** — humans, commercial review bots,
   and an in-house [shadow reviewer](../../GLOSSARY.md) run concurrently with
   distinct roles. The shadow reviewer is a *harness*, not a static analyzer:
   a repo-agnostic **core** (a tool registry, the **verify-tool invariant**,
   containment guards) plus a repo-specific **config** of numbered, additive
   [review lenses](../../GLOSSARY.md). The core/config split is what lets one
   harness serve many repositories without forking its engine. The config
   shape is [`review-config.yaml`](templates/review-config.yaml).
4. **Comment-only until proven** — a new automated reviewer posts comments and
   blocks nothing. Flipping any lens to blocking requires clearing a
   **pre-committed precision bar** (an [advisory gate](../../GLOSSARY.md)
   promoted only on measured evidence — the measurement is [M8](../M8-learning-loop/)'s
   job). The posture and the bar live in the config, so "why is this still
   advisory?" is answerable, not forgotten.
5. **The comment-resolution loop** — every review thread reaches one of four
   terminal states before merge: **addressed** (accepted and fixed here, with
   the commit linked), **rejected** (the finding is wrong or intended, with a
   reason), **deferred** (accepted but not fixed here, filed as a tracked
   follow-up), or **[moot](../../GLOSSARY.md)** (no longer applies — the code it
   anchored to is gone, with what superseded it). Scope-expanding findings and
   unresolved *human* threads are [HITL](../../GLOSSARY.md) — an agent may not
   silently widen scope or overrule a person. The
   [unresolved-threads gate](reference/comment-resolution/) makes "no open
   threads at merge" mechanical.

   `moot` earns its own state because the alternatives all corrupt something:
   folded into `rejected` it tells a learning loop the reviewer was wrong when
   it may have been right about deleted code; left open it blocks convergence
   forever. See [the gate's README](reference/comment-resolution/) for the full
   argument.

   A loop may record more than the gate needs. The plugin's
   [`resolve-review-comments`](../../plugin/skills/resolve-review-comments/README.md#outcomes)
   splits a valid finding it deliberately declines, `wont-fix`, from one that
   was wrong, `rejected`. The gate reads both as `rejected`, since either
   closes the thread; a reviewer's score must not, because one is a hit and
   the other a false positive. The skill's page says what each outcome leaves
   behind and what it measures.

6. **The verdict is declared, not inferred** — the author states which terminal
   state applies, in a form a machine can read, *at the moment of reply*.
   Reconstructing it later from prose is a measurably lossy step, and the loss
   is not random: it lands hardest on the acceptances, because "fixed in
   `<sha>`" is easy to spot while a considered rejection reads like discussion.
   A review loop that infers verdicts will therefore systematically
   under-count agreement — and if [M8](../M8-learning-loop/) consumes that,
   the reviewer's best findings come back as evidence it should stop surfacing
   them.

   Declaring costs one **decode step** that is easy to forget: no forge has a
   verdict field, so something has to turn the declared reply into the state the
   gate reads. That step is the [export adapter](../../GLOSSARY.md) —
   [the one shipped here](reference/comment-resolution/normalize-thread-states.ts)
   — and it is where "cannot tell" stays visible instead of being rounded to a
   real state. Concrete per-forge encodings are in [mappings.md](mappings.md).

7. **Rounds, and knowing when to stop** — a push that resolves one round
   re-triggers the reviewers and produces the next, so the loop's stop
   condition needs two rules that a naive "are there open threads?" check gets
   wrong:

   - **Zero open threads while a reviewer is still running is not
     convergence** — that round's comments have not posted yet, and stopping
     there abandons live findings.
   - **A merge that lands mid-loop orphans every later fix** onto a branch
     nothing will merge, silently and with no error raised. Liveness has to be
     re-checked each round, not assumed from the round before.

   Both are properties of *any* asynchronous review loop, not of a particular
   forge or bot, which is why the
   [convergence gate](reference/review-convergence/) is a portable check over an
   exported status file: its exit code is the loop's control flow, so neither
   rule depends on the person driving the loop remembering it at the point they
   are most keen to stop.

   A repository whose CI is expensive may hold it between rounds: the
   [CI hold](../../GLOSSARY.md)
   ([M13, piece 7](../M13-pipeline-economy/README.md#7-hold)) skips the
   heavy jobs on intermediate heads while a required check fails, so no held
   head is mergeable, and the release at convergence runs everything again
   on the final head.
8. **The reviewed change cannot define its reviewer** — the authoritative
   reviewer runtime, prompts, and active policy are loaded from an immutable
   external version, a separately hosted service, or the target base branch.
   The PR head is review input, not reviewer configuration. A proposed change
   to the reviewer can run in a separate unprivileged, comment-only shadow job,
   but it cannot alter the review that decides whether that same change is
   safe.
9. **Fork-safe reviewer wiring** — an automated reviewer needs repository
   secrets (model keys, a bot token) yet must inspect code from untrusted
   forks. The safe pattern extracts and analyzes the base-branch tooling while
   treating fork code as *data*, never executing it in the privileged context.
   The [PR-target safety lint](reference/pr-target-safety/) fails a workflow
   that checks out and runs untrusted PR head code in a secret-bearing job.
10. **Explicit HITL boundaries** — the human-only decision classes (merge,
   promote a reviewer to blocking, expand scope, override a human thread,
   pick the next item from the computed ranking, reopen on a rejecting
   verdict or waive a missing acceptance review, with an approver other than
   whoever runs the post-merge pass or the epic-closing step that found the
   gap, and mark Ready unless the repository delegates it to a review driver)
   are
   listed once in [`HITL-REGISTRY.md`](templates/HITL-REGISTRY.md)
   rather than scattered across skills and habits, so autonomous runs know
   exactly where to stop.
11. **Declared pull-request shape** — whether a PR may be based on another
   open PR's branch ([stacked](../../GLOSSARY.md)), how deep a stack may grow,
   how branches are named, how a PR links its issue, and how large it may be
   are one written policy, read by the agent that opens the PR.
   Without it an agent improvises, and the improvisation fails quietly: a
   hand-built stack whose layers target feature branches gives every
   base-scoped tool (a reviewer that loads its policy from the trunk, branch
   protection, deploy previews) nothing to resolve the final target from, so
   those tools skip the PR and nobody notices. The policy states the
   invariant **every PR's final target is resolvable**: either the PR targets
   the integration branch, or it is part of a forge-native stack whose
   metadata names the target, or the repository accepts plain branch chains
   and its tooling walks them. Jig's
   [`do-item`](../../plugin/skills/do-item/SKILL.md) applies the policy with
   `pr-plan.ts` and refuses a PR that breaks it; the fields are in the
   [configuration reference](../../plugin/CONFIGURATION.md#pull_requests).
12. **A post-merge stage: what does the merge still owe?** — merging closes
   the pull request, not the work, and nothing else looks at what a merge
   leaves behind. After every merge one pass settles each class of residual
   obligation, and each ends in one of two states: **owed**, and filed or
   done, or **not owed**, with the evidence that settled it. The classes:

   - **Tracker state**: the item's own state, and the epic rolled up from its
     children. The epic closes as [M9](../M9-tasks-memory/README.md#an-epic-closes-on-an-accepted-verdict)
     says, never because a pull request merged.
   - **Deferred findings**: each `deferred` reply really produced a tracked
     item. The pass re-lists the resolved threads and the summary findings,
     because a deferred thread resolves the moment its reply posts and a
     summary finding has no thread. The
     [unresolved-threads gate](reference/comment-resolution/) can check that a
     deferred reply names a reference, not that the item behind it exists:
     only a step that can reach the tracker can.
   - **Out-of-tree obligations**: every action the merge leaves outside the
     repository is listed when the pull request opens and recorded where a
     person will find it, in the tracker item and in the repository's own
     ledger of such work where it keeps one.
   - **Temporary scaffolding**: reverted, in the repository and outside it. A
     widened timeout, a disabled gate, a live review driver, a working
     branch, an environment or a flipped flag each stays behind unless
     something looks for it.
   - **Live verification**: owed only when the change has a runtime surface,
     has reached an environment and is not already covered by CI. Anything
     else is not owed, and says which condition it fails.
   - **Next step**: picked with a bias toward closure. Finish a nearly-done
     epic first; otherwise clear the operations that can be cleared;
     otherwise take a batch of small items
     ([`/jig:work-batch`](../../plugin/skills/work-batch/README.md)).
     A computed ranking proposes the shortlist; picking from it is a human
     decision. It is not owed only when the tracker shows no open work.

   "Nothing found" is not evidence because a pass that looks in the wrong
   place finds nothing just as a clean one does; a reason names a fact
   ("no file under the deploy directory changed") that someone else can
   check. The decisions the stage hands to a person (see core piece 10)
   are rows of the [HITL registry](templates/HITL-REGISTRY.md). Step 6 of
   [`PR-LIFECYCLE.md`](templates/PR-LIFECYCLE.md) is the copyable form, and
   [mappings.md](mappings.md#the-post-merge-stage) says how each class is
   checked per forge and tracker.

## Maturity levels

- **Lite** — PRs open as drafts (or Ready, where the repository declares
  that none of its reviewers reviews drafts), a human marks any draft Ready,
  and a human merges; the
  lifecycle is written down once (`PR-LIFECYCLE.md`) and self-review before
  requesting review is expected. Review may be humans-only; enforcement may be
  convention.
- **Standard** — the pull-request shape policy (stacking, branch names,
  issue link, size) is declared where the PR-opening agent reads
  it; mandatory reviews are selected by change-area
  ([M3](../M3-change-area-catalog/)); at least one automated reviewer runs
  **comment-only** with a written precision bar for ever blocking; the
  comment-resolution loop is a contract (addressed/rejected/deferred/moot,
  every thread terminal, the state declared in an anchored encoding that an
  export adapter decodes rather than inferred from prose) and no PR merges with
  unresolved threads; any reviewer executing
  PR code uses the fork-safe wiring; no authoritative reviewer obtains its
  runtime, prompts, or active policy from the PR head it is reviewing; and
  a post-merge stage settles each class of residual obligation as owed (filed
  or done) or not owed (with evidence), including that every deferred reply
  produced a tracked item.
- **Strict** — the unresolved-threads gate and the PR-target safety lint run in
  CI (the authority); the declared verdict is validated by whatever *posts* the
  reply, at write time, with an opt-out for replies that are not verdicts; the
  review loop's stop condition is a mechanical convergence check rather than a
  judgement call; the HITL decision registry is published and the `hitl`
  label revokes autonomous merge; the pull-request shape policy is applied by
  the tool that opens PRs, so a stack whose final target cannot be resolved is
  refused rather than opened; reviewer promotion comment-only→blocking is
  gated on measured precision from the [M8](../M8-learning-loop/) corpus; the
  gates ship with self-tests run in CI.

## Adoption steps

1. Copy [`PR-LIFECYCLE.md`](templates/PR-LIFECYCLE.md) into your docs tree and
   adjust the checkpoints to your forge; turn on required-draft / required-human
   settings where the forge supports them.
2. Point the mandatory-review selection at your [M3](../M3-change-area-catalog/)
   review-gate projection instead of a hand-kept list.
3. If you run an automated reviewer, express it as
   [`review-config.yaml`](templates/review-config.yaml) (tool registry,
   comment-only posture, numbered lenses, precision bar, reviewer source).
   Load the authoritative runtime and policy from a pinned external version,
   hosted service, or target base branch; test proposed reviewer changes in a
   separate unprivileged shadow run. Wire the reviewer fork-safe and add the
   [PR-target safety lint](reference/pr-target-safety/) so the wiring can't
   regress.
4. Adopt the [unresolved-threads gate](reference/comment-resolution/) as a
   merge gate. Pick a verdict encoding, and wire the
   [export adapter](reference/comment-resolution/normalize-thread-states.ts)
   between your forge and the gate — mapping your own vocabulary in its
   `canon()` rather than loosening the gate (recipes in
   [mappings.md](mappings.md)).
5. Drive the resolve→push→re-review loop with the
   [convergence gate](reference/review-convergence/) instead of a person
   deciding when it looks done, so a still-running reviewer or a mid-loop merge
   cannot end the loop quietly.
6. Fill in [`HITL-REGISTRY.md`](templates/HITL-REGISTRY.md) and wire the `hitl`
   label / draft rules to it.
7. Declare the pull-request shape: whether PRs may stack and how (forge-native
   stacks or plain branch chains), the maximum stack depth, branch naming,
   the issue link, and the size budget. With Jig's plugin
   that is the `pull_requests` section of `.config/jig.yaml`
   ([reference](../../plugin/CONFIGURATION.md#pull_requests)); per-tool
   options are in [mappings.md](mappings.md#stacked-pull-requests).
8. Run the post-merge stage after every merge, as step 6 of
   [`PR-LIFECYCLE.md`](templates/PR-LIFECYCLE.md) states it: by the session
   that drove the pull request, by a person, or by a scheduled job. Record
   each class as owed or not owed with its evidence in the tracker item's
   closing comment, or, for a pull request no tracked item names, in a pass
   report or a comment on the pull request, and add the rows for its human
   decisions to your [HITL registry](templates/HITL-REGISTRY.md).

## Status

### Runnable form

The practice runs as skills in Jig's
[`jig` plugin](../../plugin/README.md), installed once per machine for
Claude Code and Codex. Each reads the repository's own reviewers, tracker
values and gate commands from its configuration at run time
([setup](../../plugin/README.md#the-drive-loop-and-issue-pickup)).

| Skill or agent | The part of this practice it runs |
|----------------|-----------------------------------|
| [`resolve-review-comments`](../../plugin/skills/resolve-review-comments/README.md) | The comment-resolution loop (core pieces 5 and 6): walks every unresolved thread to a declared outcome, and its `reply-to-thread.ts` validates the verdict as the reply is written (`--no-outcome` is the opt-out for a reply that is not a verdict) |
| [`drive-pr`](../../plugin/skills/drive-pr/README.md) | The [PR drive loop](../../GLOSSARY.md) (core piece 7) run unattended: waits for reviewers to settle, stops on a named end state, marks a draft Ready at the point `pull_requests.mark_ready` declares, and never merges |
| [`do-item`](../../plugin/skills/do-item/SKILL.md) | Opens the pull request under the declared shape policy (core piece 11) through its `pr-plan.ts`, and refuses one that breaks it; its post-merge status rule and mandatory `## Out-of-tree follow-ups` section run the tracker-state and out-of-tree classes of the post-merge stage (core piece 12) |
| [`review`](../../plugin/skills/review/SKILL.md) | The author-side tiered review before pushing (the agent-runtime reviewer in core piece 3) |
| [Review Arbiter](../../plugin/agents/review-arbiter.md) | Rules on contested findings the triage rubric cannot settle |
| [`resolve-conflicts`](../../plugin/skills/resolve-conflicts/SKILL.md) | Brings a conflicting pull request up to date with its base: records each conflict decision in the merge commit for reviewers and refuses a resolution that silently drops either side's change |

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/PR-LIFECYCLE.md`](templates/PR-LIFECYCLE.md) | The copyable lifecycle contract, draft to the post-merge stage, with its human-in-the-loop boundaries |
| [`templates/HITL-REGISTRY.md`](templates/HITL-REGISTRY.md) | The human-only decision classes, each with its trigger (shared with [M0](../M0-instruction-architecture/)) |
| [`templates/review-config.yaml`](templates/review-config.yaml) | The config half of the review-harness core/config split: tool registry, postures, reviewer source, verify tool, containment guards, precision bar, numbered lenses |
| [`reference/comment-resolution/`](reference/comment-resolution/) | The unresolved-threads merge gate, and the verdict export adapter that decodes a declared reply into the gate's states |
| [`reference/review-convergence/`](reference/review-convergence/) | The round stop condition: waits for reviewers to settle, aborts on a PR that stopped being open |
| [`reference/pr-target-safety/`](reference/pr-target-safety/) | The fork-safe wiring lint |
| [`mappings.md`](mappings.md) | Forges, stacked-PR tools, review bots, agent-runtime reviewers, CI providers, trackers |
| [maturity criteria](../../plugin/skills/audit/criteria/M7-pr-lifecycle-review.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Each reference gate ships with a self-test and fixtures, and delegates to the
shared implementation in [`lib/module-gates.ts`](../../lib/module-gates.ts);
keep the module and `lib/` together when you vendor them.

### The verdict encoding

The invariant that a verdict is declared rather than inferred (core piece 6)
rests on evidence that does not depend on any one encoding: on a real corpus,
treating resolved-with-a-reply as rejection classified **all** of a reviewer's
threads as rejections when roughly half were acceptances, and a later prose
classifier over the same corpus still lost or misfiled a majority of
*declared* outcomes. The `moot` state rests on the same kind of evidence: such
threads were observed being scored as push-back.

Which encoding should carry the verdict is less settled. The bold leading
token has not yet run through enough review cycles to be called the answer, so
two layers treat it differently:

| Layer | Treatment of the bold-token encoding |
|-------|--------------------------------------|
| The [`resolve-review-comments`](../../plugin/skills/resolve-review-comments/README.md) skill and its `reply-to-thread.ts` | Uses the bold leading token and enforces it at reply time. The skill is one operated mechanism, kept whole rather than rewritten into an encoding-neutral variant that would become a fork |
| This module's practice references: [mappings.md](mappings.md), the [export adapter](reference/comment-resolution/normalize-thread-states.ts), the lifecycle contract | Encoding-**agnostic**. What they assert is the invariant: a verdict is declared, in an anchored form, at reply time. [mappings.md](mappings.md) presents a leading token and a trailing trailer as alternatives and states no preference; adopter vocabulary lives in the adapter's `canon()`, and the token is its default only because a default is required |

An adopter that does not run the skill is free to choose the trailer form; one
that does inherits the token. The obligation sits on two rungs of the
enforcement ladder ([M1](../M1-gates-enforcement-ladder/)): declaring in an
anchored encoding is a **Standard** convention, while validating the verdict
at write time, which needs a reply-posting tool to hang it on, is **Strict**.
When the encoding question settles, only the skill's token vocabulary would
change; the practice references above would not.

### Left out by design

- **A lens catalogue beyond the seed lenses.** Jig ships a few
  [seed lenses](../../GLOSSARY.md) with the
  [`review`](../../plugin/skills/review/SKILL.md) skill, each the review
  form of one rule a Jig module states (`jig.swallowed-failure` for
  [M15](../M15-contracts-errors/)'s rules on failures), and the lens file
  as the contract: one Markdown file per lens, holding its id and version,
  the rules it enforces, the trigger that selects it, the evidence every
  finding must give, and what is and is not a finding. `review` runs those
  files, and a repository's shadow reviewer can load the same ones. A
  repository's own lenses and its model-routing tiers are its tuned
  content, not a portable mechanism: they are grown locally through
  [M8](../M8-learning-loop/), in the same file format.
- **A reviewer runtime.** A review harness is an agent job in whatever
  language the repository uses, so the module specifies its config contract
  and ships only the pieces that are portable gates: the fork-safe wiring
  lint, the resolution gate and its exporter, and the convergence check.
- **Precision-bar values and their measurement wiring.** They belong with
  [M8](../M8-learning-loop/) (the measurement) and
  [M11](../M11-process-observability/) (the emission).
- **What CI spends on a pull request.** Cancelling the runs of a superseded
  head, selecting jobs by what changed, and the
  [CI hold](../../GLOSSARY.md) between review rounds are
  [M13 pipeline economy](../M13-pipeline-economy/README.md).

### Future

- **A runnable post-merge stage for any repository.** The stage is stated
  here and run by hand or by a repository's own skill; the plugin does not
  yet ship a skill that runs the whole pass (it runs the status rule and the
  out-of-tree section only). It is part of
  [ROADMAP item 17](../../ROADMAP.md#17-corrected-designs-for-the-existing-modules).

- **Delegated merge.** Letting a converged drive arm the forge's auto-merge
  for the exact head it certified relaxes "a human merges", so it waits on
  its own decision; it is open work in the [roadmap](../../ROADMAP.md).
