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

> PRs open as **drafts**; a human marks Ready and a human merges
> ([HITL](../../GLOSSARY.md)). The **mandatory review steps are selected by
> what changed** (via the [M3](../M3-change-area-catalog/) change-area
> catalog), not by reviewer memory. Every review comment ends **resolved with
> an audit trail** — in one of a **closed set of terminal states, declared by
> the author rather than inferred from prose** — before merge. Review is a
> **loop over [rounds](../../GLOSSARY.md)**, and its stop condition is a round
> that finds nothing left, not a single pass. **Automated reviewers run
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
   deliberate human act, and so is the **merge**. The narrative contract —
   open draft → self-review → automated + human review → resolve loops → gates
   green → Ready → merge → tracker update — is the copyable
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
   [review lenses](../../GLOSSARY.md). The core/config split is what let the
   reference implementation reuse the same harness across repos. The config
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
   [the one shipped here](reference/comment-resolution/normalize-thread-states.sh)
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
10. **Explicit HITL boundaries** — the human-only decision classes (mark Ready,
   merge, promote a reviewer to blocking, expand scope, override a human
   thread) are listed once in [`HITL-REGISTRY.md`](templates/HITL-REGISTRY.md)
   rather than scattered across skills and habits, so autonomous runs know
   exactly where to stop.

## Maturity levels

- **Lite** — PRs open as drafts and a human marks Ready and merges; the
  lifecycle is written down once (`PR-LIFECYCLE.md`) and self-review before
  requesting review is expected. Review may be humans-only; enforcement may be
  convention.
- **Standard** — mandatory reviews are selected by change-area
  ([M3](../M3-change-area-catalog/)); at least one automated reviewer runs
  **comment-only** with a written precision bar for ever blocking; the
  comment-resolution loop is a contract (addressed/rejected/deferred/moot,
  every thread terminal, the state declared in an anchored encoding that an
  export adapter decodes rather than inferred from prose) and no PR merges with
  unresolved threads; any reviewer executing
  PR code uses the fork-safe wiring; and no authoritative reviewer obtains its
  runtime, prompts, or active policy from the PR head it is reviewing.
- **Strict** — the unresolved-threads gate and the PR-target safety lint run in
  CI (the authority); the declared verdict is validated by whatever *posts* the
  reply, at write time, with an opt-out for replies that are not verdicts; the
  review loop's stop condition is a mechanical convergence check rather than a
  judgement call; the HITL decision registry is published and the `hitl`
  label revokes autonomous merge; reviewer promotion comment-only→blocking is
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
   [export adapter](reference/comment-resolution/normalize-thread-states.sh)
   between your forge and the gate — mapping your own vocabulary in its
   `canon()` rather than loosening the gate (recipes in
   [mappings.md](mappings.md)).
5. Drive the resolve→push→re-review loop with the
   [convergence gate](reference/review-convergence/) instead of a person
   deciding when it looks done, so a still-running reviewer or a mid-loop merge
   cannot end the loop quietly.
6. Fill in [`HITL-REGISTRY.md`](templates/HITL-REGISTRY.md) and wire the `hitl`
   label / draft rules to it.

## Port status

| Source (docomply `develop`) | Landed as |
|-----------------------------|-----------|
| `docs/development/pr-lifecycle.md` (C2) — draft→review→resolve→merge narrative | [`templates/PR-LIFECYCLE.md`](templates/PR-LIFECYCLE.md) — copyable lifecycle contract with HITL boundaries |
| Shadow-reviewer harness core/config split (tool registry, verify-tool invariant, containment guards, `review-config.yaml` schema) | [`templates/review-config.yaml`](templates/review-config.yaml) + [`reference/pr-target-safety/`](reference/pr-target-safety/) — the config schema, and the security invariant as a runnable lint |
| `resolve-review-comments` skill + GraphQL resolve scripts (address/reject/defer loop) | [`reference/comment-resolution/`](reference/comment-resolution/) — the loop as a mechanical merge gate, plus the verdict **export adapter** that decodes a declared reply into its states; both with self-tests + fixtures. The loop *contract* is in `PR-LIFECYCLE.md` |
| the same skill's round loop (re-review after each push, stop when clean) | [`reference/review-convergence/`](reference/review-convergence/) — the stop condition as a portable check: waits for reviewers to settle, aborts on a PR that stopped being open |
| `docs/development/hitl-decision-registry.md` (C6) — human-only decision classes | [`templates/HITL-REGISTRY.md`](templates/HITL-REGISTRY.md) — generic decision registry (shared with [M0](../M0-instruction-architecture/)) |

Also landed: [`mappings.md`](mappings.md) (forges, review bots, agent-runtime
reviewers, CI providers, trackers) and [`maturity.yaml`](maturity.yaml).

**Backflow, 2026-07-24.** A live extraction of a reviewer into its own
versioned repository exposed a security property that the earlier fork-safety
wording did not state strongly enough: the change under review must not control
the reviewer code or policy that judges it. The invariant, config contract,
mapping guidance, audit prompt, and maturity criteria now state that property
directly.

**Newly adopted upstream, not yet proven by cycles.** The *invariant* that a
verdict is declared rather than inferred (core piece 6) is evidence-backed
independently of any one implementation: on a real corpus, treating
resolved-with-a-reply as rejection classified **all** of a reviewer's threads as
rejections when roughly half were acceptances, and a later prose classifier over
the same corpus still lost or misfiled a majority of *declared* outcomes. The
`moot` state is likewise evidenced — those threads were observed in the wild
being scored as push-back.

What is **not** yet proven, and is therefore **not** what this module ports, is
the reference implementation's specific *choice* of encoding — a bold leading
token — which landed recently and has not run through enough review cycles to be
called settled. Drawing that line precisely, because it is the line "don't port
the unproven" turns on:

| Ported | Left to the adopter / deferred |
|--------|-------------------------------|
| The invariant: the verdict is declared, in an anchored form, at reply time | *Which* anchored form. [mappings.md](mappings.md) presents a leading token and a trailing trailer as alternatives and states no preference |
| An encoding-**agnostic** [export adapter](reference/comment-resolution/normalize-thread-states.sh): both encodings are one variable apart, adopter vocabulary lives in its `canon()` | The reference implementation's bold-token convention as *the* mechanism. It is the exporter's default only because a default is required |
| That write-time enforcement is the top rung of the enforcement ladder for this obligation, as it is for every other ([M1](../M1-gates-enforcement-ladder/)) | The reference implementation's particular reply-posting script, which is not transcribed here |

So the obligation is split across two rungs rather than asserted at one:
declaring in an anchored encoding is a **standard** convention, while validating
the verdict at write time — which needs a reply-posting tool to hang it on, and
names no encoding — is **strict**. Revisit the encoding question once the
reference implementation has cycles behind it; nothing above has to change when
it settles, which is the point of keeping the choice out of the mechanism.

**Not ported** (per "don't port the unproven" / IP scrub): the shadow
reviewer's actual lens catalogue (44 product-specific lenses) and its
model-routing tiers are the reference implementation's tuned content, not a
portable mechanism — groundwork ports the *harness shape* (registry + posture +
numbered additive lenses) and leaves the catalogue to be grown locally through
[M8](../M8-learning-loop/). The TypeScript reviewer runtime itself is not
transcribed to bash: a review harness is an agent/LLM job in whatever language
the target uses, so groundwork specifies the config contract and lands only the
two pieces that *are* genuinely portable gates (the fork-safe wiring lint and
the resolution gate). The precision-bar *values* and the measurement wiring
belong with [M8](../M8-learning-loop/) and [M11](../M11-process-observability/).
