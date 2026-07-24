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
> an audit trail** — fixed with a reference, or rejected/deferred with a
> stated reason — before merge. **Automated reviewers run comment-only** until
> measured precision clears a pre-committed bar that justifies more. And any
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
5. **The comment-resolution loop** — every review thread reaches a terminal
   state before merge: **addressed** (fixed, with the commit/reason linked),
   **rejected** (won't fix, with a reason), or **deferred** (filed as a
   tracked follow-up). Scope-expanding findings and unresolved *human* threads
   are [HITL](../../GLOSSARY.md) — an agent may not silently widen scope or
   overrule a person. The [unresolved-threads gate](reference/comment-resolution/)
   makes "no open threads at merge" mechanical.
6. **The reviewed change cannot define its reviewer** — the authoritative
   reviewer runtime, prompts, and active policy are loaded from an immutable
   external version, a separately hosted service, or the target base branch.
   The PR head is review input, not reviewer configuration. A proposed change
   to the reviewer can run in a separate unprivileged, comment-only shadow job,
   but it cannot alter the review that decides whether that same change is
   safe.
7. **Fork-safe reviewer wiring** — an automated reviewer needs repository
   secrets (model keys, a bot token) yet must inspect code from untrusted
   forks. The safe pattern extracts and analyzes the base-branch tooling while
   treating fork code as *data*, never executing it in the privileged context.
   The [PR-target safety lint](reference/pr-target-safety/) fails a workflow
   that checks out and runs untrusted PR head code in a secret-bearing job.
8. **Explicit HITL boundaries** — the human-only decision classes (mark Ready,
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
  comment-resolution loop is a contract (address/reject/defer, every thread
  terminal) and no PR merges with unresolved threads; any reviewer executing
  PR code uses the fork-safe wiring; and no authoritative reviewer obtains its
  runtime, prompts, or active policy from the PR head it is reviewing.
- **Strict** — the unresolved-threads gate and the PR-target safety lint run in
  CI (the authority); the HITL decision registry is published and the `hitl`
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
   merge gate; export thread states from your forge into its input format
   (recipes in [mappings.md](mappings.md)).
5. Fill in [`HITL-REGISTRY.md`](templates/HITL-REGISTRY.md) and wire the `hitl`
   label / draft rules to it.

## Port status

| Source (docomply `develop`) | Landed as |
|-----------------------------|-----------|
| `docs/development/pr-lifecycle.md` (C2) — draft→review→resolve→merge narrative | [`templates/PR-LIFECYCLE.md`](templates/PR-LIFECYCLE.md) — copyable lifecycle contract with HITL boundaries |
| Shadow-reviewer harness core/config split (tool registry, verify-tool invariant, containment guards, `review-config.yaml` schema) | [`templates/review-config.yaml`](templates/review-config.yaml) + [`reference/pr-target-safety/`](reference/pr-target-safety/) — the config schema, and the security invariant as a runnable lint |
| `resolve-review-comments` skill + GraphQL resolve scripts (address/reject/defer loop) | [`reference/comment-resolution/`](reference/comment-resolution/) — the loop as a mechanical merge gate + self-test + fixtures; the loop *contract* in `PR-LIFECYCLE.md` |
| `docs/development/hitl-decision-registry.md` (C6) — human-only decision classes | [`templates/HITL-REGISTRY.md`](templates/HITL-REGISTRY.md) — generic decision registry (shared with [M0](../M0-instruction-architecture/)) |

Also landed: [`mappings.md`](mappings.md) (forges, review bots, agent-runtime
reviewers, CI providers, trackers) and [`maturity.yaml`](maturity.yaml).

**Backflow, 2026-07-24.** A live extraction of a reviewer into its own
versioned repository exposed a security property that the earlier fork-safety
wording did not state strongly enough: the change under review must not control
the reviewer code or policy that judges it. The invariant, config contract,
mapping guidance, audit prompt, and maturity criteria now state that property
directly.

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
