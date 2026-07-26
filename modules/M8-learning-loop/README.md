# M8 — Learning loop

**What problem this solves.** Checklists, reviewers, and gates freeze on the
day they were written. Something slips through — a reviewer misses a bug, a gate
has a blind spot, an agent repeats a mistake — and without a loop, the *same
class* of miss recurs, because nothing turned that miss into a durable check.
The usual failure mode is a Slack post-mortem, a nod, and no change to the
system. This module packages the loop that converts a miss into a permanent
improvement — the **miss→lens [flywheel](../../GLOSSARY.md)** — plus the two
companion cycles (session reflection and memory promotion) that keep the
scaffolding itself learning. It is the most transferable practice in
groundwork: it applies to *any* evaluable agent behavior, not just review.

## Invariant

> Every significant miss (by a reviewer, gate, or agent) is **classified**
> against a taxonomy, **filed with a durable identifier**, **reconstructed as a
> replayable [eval fixture](../../GLOSSARY.md)** that pins the *pre-fix* state,
> and **answered with an additive [lens](../../GLOSSARY.md)** (a check appended,
> never a rewrite). A fixture joins the **regression corpus only after a live
> run validates** it (`required: false` until then). Lenses are **kept or
> killed by measurement**, not opinion. And **scaffolding changes proposed by
> reflection require human approval** ([HITL](../../GLOSSARY.md)) — the system
> may suggest changes to its own rules, but a person approves them.

Concrete per-runtime, per-tracker wiring is in [mappings.md](mappings.md).

## The flywheel, step by step

An oracle (an external reviewer or a human) catches what the automated system
missed. Then:

1. **Classify** — bucket the miss against a fixed [miss taxonomy](templates/miss-taxonomy.yaml)
   (a closed vocabulary, so patterns are countable — "we miss error-path bugs a
   lot" becomes visible).
2. **File with a durable id** — record it with a stable **lever** number
   (`L-NNNN`) in a tracker, so it can be referenced forever. Lever numbers are
   unique — the same collision problem as [ADRs](../M5-adr-practice/) (parallel
   authors pick the same next number), solved the same way.
3. **Reconstruct as a pre-fix fixture** — capture the miss as a replayable
   [eval fixture](../../GLOSSARY.md) pinning the commit *before* the fix, with
   the finding it *should* have produced. Pre-fix, because a fixture pinned
   after the fix proves nothing.
4. **Answer with an additive lens** — add one numbered [review lens](../../GLOSSARY.md)
   (or checklist bullet, or gate) that would have caught it. Additive: the lens
   list only grows, so a fix for today's miss never silently deletes yesterday's
   coverage. The lens links back to its lever.
5. **Validate, then gate** — run the reviewer against the new fixture live. Only
   once it demonstrably catches the miss does the fixture flip to
   `required: true` and join the **regression corpus** — the set that must keep
   passing forever. An unvalidated fixture in the blocking gate is theater.
6. **Measure** — track recall / precision / cost of the lens marginally against
   oracles (the [parity report](reference/parity-report/)), including a
   `missed_blockers` count. Measurement decides whether a lens is promoted to
   blocking (feeds [M7](../M7-pr-lifecycle-review/)'s precision bar), kept
   advisory, or killed.

## The two companion cycles

- **Session reflection** — a `/reflect`-style step accumulates end-of-session
  feedback into an inbox; a separate step processes it into proposed scaffolding
  changes **with mandatory human approval** before anything is edited. Changing
  the rules the agents follow is self-modifying, so it is HITL by construction
  (see [`HITL-REGISTRY`](../M7-pr-lifecycle-review/templates/HITL-REGISTRY.md)).
- **Memory promotion** — an agent's private, per-session memory is periodically
  promoted (via a `/promote-memory`-style step) into git-tracked, shared team
  memory, so a lesson one agent learned survives the session and reaches the
  others. Promotion is a review point, not an automatic dump.

Both cycles are the same shape as the flywheel — *observe → durable record →
validate → adopt* — applied to process feedback and to memory instead of to
review misses.

### Triggering reflection on evidence, not goodwill

Session reflection only compounds if it actually happens, and "reflect when it
felt hard" reliably under-fires: the sessions with the most to say are the ones
that end tired and late.

So trigger it on an **observable** instead. The strongest one available is the
number of review rounds a change took to converge
([M7](../M7-pr-lifecycle-review/) core piece 7). A change that needed many
rounds is rarely evidence of a noisy reviewer; it usually means the scaffolding
under-served it — an instruction that did not land, a rule the reviewer had to
teach repeatedly, a convention that should have been mechanised, or a reviewer
config that let a known class through. Each of those is a **lever**, which is
exactly what this module's flywheel consumes.

Two properties make the trigger work:

- **Emit at convergence, not afterwards.** The detail is richest at the moment
  the loop ends and decays quickly once the session closes. A prompt that
  arrives the next day gets a summary; one that arrives at convergence gets the
  specifics.
- **Carry the round count and the change identifier into the record.** A
  reflection entry that cannot be aggregated is an anecdote. With the count
  attached, the inbox answers "which changes fought the scaffolding hardest",
  which is the question that ranks the levers.

The threshold is a local calibration — set it where it fires on the genuinely
hard reviews and not on ordinary ones, and keep it adjustable. "The reviewer was
wrong repeatedly" is itself a finding, and routes to the reviewer's config or
its eval corpus rather than to the instruction files.

Both properties are mechanical in the
[reflection trigger](reference/reflection-trigger/): it fires only on M7's
`CONVERGED` decision, and it writes the change id and round count into the
[inbox record](templates/reflection-inbox.md) itself rather than trusting anyone
to remember them. What it deliberately leaves to a person is the judgement —
which lever, or whether the reviewer was the thing that was wrong.

## Maturity levels

- **Lite** — the flywheel is written down ([`FLYWHEEL.md`](templates/FLYWHEEL.md))
  and misses are actually captured somewhere durable with a lever id and a
  taxonomy category; a reflection habit exists. Enforcement may be convention.
- **Standard** — misses live in a machine-readable [corpus](templates/corpus.yaml)
  where every entry has a **unique lever id**, a **valid taxonomy category**,
  and a **pinned pre-fix commit**, validated by [corpus-lint](reference/corpus-lint/)
  in CI; lenses are additive and numbered; reflection-proposed scaffolding
  changes require human approval.
- **Strict** — the **validate-then-gate** promotion is mechanical (a fixture is
  `required: true` only with a recorded validation); a [parity report](reference/parity-report/)
  measures recall / precision / `missed_blockers` and gates reviewer promotion
  ([M7](../M7-pr-lifecycle-review/)); reflection fires from an
  [observable](reference/reflection-trigger/) — a review-round threshold — rather
  than from the author remembering, and the record carries the measurement that
  triggered it; the gates ship self-tests run in CI;
  memory promotion lands in git-tracked shared memory.

## Adoption steps

1. Copy [`FLYWHEEL.md`](templates/FLYWHEEL.md) and
   [`miss-taxonomy.yaml`](templates/miss-taxonomy.yaml); prune the taxonomy to
   the miss classes your system actually produces.
2. Start a [`corpus.yaml`](templates/corpus.yaml): every time an oracle catches
   a miss, add an entry (lever id, taxonomy category, pinned pre-fix commit,
   the lens that answers it, `required: false`).
3. Add [corpus-lint](reference/corpus-lint/) as a CI gate so the corpus can't
   drift (duplicate levers, unknown categories, unvalidated fixtures promoted).
4. Once you measure reviewers against oracles, feed the tallies to the
   [parity report](reference/parity-report/) and let `missed_blockers` /
   precision drive the [M7](../M7-pr-lifecycle-review/) promotion decisions.
5. Copy [`reflection-inbox.md`](templates/reflection-inbox.md) and put the
   [reflection trigger](reference/reflection-trigger/) at the end of
   [M7](../M7-pr-lifecycle-review/)'s review loop, so a hard review prompts
   reflection at convergence rather than whenever someone thinks of it. Tune
   `ROUND_THRESHOLD` once you have seen a few fire.
6. Wire the reflection + memory-promotion steps to your runtime (recipes in
   [mappings.md](mappings.md)), keeping the human-approval checkpoint.

## Port status

| Source (docomply `develop`) | Landed as |
|-----------------------------|-----------|
| `docs/development/ai-tools/miss-to-lens-flywheel.md` (C5) — the named process doc | [`templates/FLYWHEEL.md`](templates/FLYWHEEL.md) — copyable flywheel + reflection + memory-promotion cycles |
| shadow-reviewer miss taxonomy (the classification vocabulary) | [`templates/miss-taxonomy.yaml`](templates/miss-taxonomy.yaml) — a **generic** taxonomy (docomply's actual categories are IP-scrubbed out) |
| eval-harness shape (`tools/ai/eval/`, `corpus.yaml` header) | [`templates/corpus.yaml`](templates/corpus.yaml) + [`reference/corpus-lint/`](reference/corpus-lint/) — the corpus schema and its invariant gate + self-test |
| parity-tracker shape (`tools/ai/parity/`) + the `missed_blockers` gate metric | [`reference/parity-report/`](reference/parity-report/) — a portable recall/precision + `missed_blockers` gate + self-test |
| `reflect` / `review-reflection-feedback` / `promote-memory` command patterns | documented as the two companion cycles in [`FLYWHEEL.md`](templates/FLYWHEEL.md), with the human-approval HITL boundary |
| the reflection prompt's firing rule (a review-round threshold) | [`reference/reflection-trigger/`](reference/reflection-trigger/) + [`templates/reflection-inbox.md`](templates/reflection-inbox.md) — the trigger as a portable step over [M7](../M7-pr-lifecycle-review/)'s convergence line, writing an aggregable record |

Also landed: [`mappings.md`](mappings.md) (trackers for lever ids, eval
runners, telemetry, per-runtime reflect/memory commands) and
[`maturity.yaml`](maturity.yaml).

**Not ported** (per "don't port the unproven" / IP scrub): docomply's actual
miss-taxonomy categories and reviewer-tier names are adjacent to its invention
disclosure and are replaced with a neutral, generic taxonomy — grow your own
categories from your own misses. The reference implementation's eval *runner*
(the code that replays a fixture through an LLM reviewer and diffs findings) is
an LLM job best written in the target repo's own language, so groundwork
specifies the corpus contract and lands only the two pieces that are genuinely
portable gates (corpus invariants; the parity arithmetic). Its actual eval
fixtures are product-domain and unvalidated-until-run, so none are vendored. The
specific telemetry wiring (event names, dashboards) belongs with
[M11](../M11-process-observability/).
