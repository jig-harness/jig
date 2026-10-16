# M8 — Learning loop

**What problem this solves.** Checklists, reviewers, and gates freeze on the
day they were written. Something slips through — a reviewer misses a bug, a gate
has a blind spot, an agent repeats a mistake — and without a loop, the *same
class* of miss recurs, because nothing turned that miss into a durable check.
The usual failure mode is a Slack post-mortem, a nod, and no change to the
system. This module packages the loop that converts a miss into a permanent
improvement — the **miss→lens [flywheel](../../GLOSSARY.md)** — plus the two
companion cycles (session reflection and memory promotion) that keep the
scaffolding itself learning, and a catalog of the areas that drift without any
miss to learn from. It is the most transferable practice in
jig: it applies to *any* evaluable agent behavior, not just review.

## Invariant

> Every significant miss (by a reviewer, gate, or agent) is **classified**
> against a taxonomy, **filed with a durable identifier**, **reconstructed as a
> replayable [eval fixture](../../GLOSSARY.md)** that pins the *pre-fix* state,
> and **answered with an additive [lens](../../GLOSSARY.md)** (a check appended,
> never a rewrite). A fixture joins the **regression corpus only after a live
> run validates** it (`required: false` until then). Lenses are **kept or
> killed by measurement**, not opinion. **Reflection records are
> append-only, carry an id, and their state is computed** from them, never
> stored beside them. And **scaffolding changes proposed by reflection
> require human approval** ([HITL](../../GLOSSARY.md)) — the system may
> suggest changes to its own rules, but a person approves them. And every
> **drift-prone area** that no gate fully covers has a named cadence, an owner
> and a last-audited date in an **audit catalog**, an area audited only by hand
> being tracked as a gap in tooling.

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
  feedback into a shared store; a separate step processes it into proposed
  scaffolding changes **with mandatory human approval** before anything is
  edited. Changing the rules the agents follow is self-modifying, so it is HITL
  by construction (see [`HITL-REGISTRY`](../M7-pr-lifecycle-review/templates/HITL-REGISTRY.md)).
  The records are an append-only log of events (a finding, a decision about
  it), each with an id fixed before it is first written, so a retried or
  concurrent write never counts a finding twice; a finding's status, and how
  often its class recurred, are computed from the log when it is read. That is
  what lets every repository and worktree write to one store, a plain folder
  included, without locks or conflicts. Jig's plugin runs this cycle as
  [`reflect`](../../plugin/skills/reflect/README.md) and
  [`review-reflections`](../../plugin/skills/review-reflections/README.md).
- **Memory promotion** — an agent's private, per-session memory is periodically
  promoted (via a `/promote-memory`-style step) into git-tracked, shared team
  memory, so a lesson one agent learned survives the session and reaches the
  others. Promotion is a review point, not an automatic dump. Jig's
  plugin runs this step as
  [`promote-memory`](../../plugin/skills/promote-memory/SKILL.md).

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
which lever, or whether the reviewer was the thing that was wrong. Jig's
plugin applies the same trigger in its own review loop, recording the round
count as a finding in the reflection journal at convergence.

## The audit catalog: areas no gate covers

The flywheel answers misses that have already happened. Some parts of a
repository drift without producing one: a diagram that no longer matches the
code, settings kept in a hosted service, a policy that no lockfile can express,
runbooks that were never rehearsed. No gate fails, so nobody looks, and the
first sign is the incident. Jig's own [`/jig:audit`](../../plugin/skills/audit/README.md)
does not cover this: it scores whether a repository has *adopted* Jig's
practices, not the health of its code or its systems.

The practice is a single list, the [audit catalog](../../GLOSSARY.md),
with one row for every [drift-prone area](../../GLOSSARY.md) that no gate fully covers. Each row
carries:

- an **owner**, one person or team, who sees that the audit happens;
- a **cadence**: `continuous`, `per release`, `monthly`, `quarterly` or `ad hoc`
  (the last only with a named trigger, or the area has no cadence at all);
- the **tooling** that performs or supports the audit, or `manual`;
- the date the area was **last audited**, advanced when an audit finishes
  whether or not it found anything;
- the **open work** the last audit left, as tracker keys.

An area audited only by hand is **tracked as a gap in tooling**: its open-work
cell names the issue that would replace the manual step with a check, or says
why the step cannot be automated. Manual
audits are right while an area's rules are still being found; the row keeps the
repeating cost visible instead of letting it become permanent.

The catalog is the learning loop's second entry point. A miss the flywheel
classifies often turns out to be an area the catalog did not list, and a manual
row that keeps finding the same class of problem is the strongest case for the
gate that would replace it ([M1](../M1-gates-enforcement-ladder/README.md)).
The periodic wiki lint of [M4](../M4-docs-governance/README.md) is one row of
such a catalog: the documentation tree, audited on a schedule.

Where audits are deep reviews of a whole area along a fixed list of dimensions,
an optional [deep-review tracker](templates/deep-review-tracker.md) keeps the
list versioned and queues a re-review of every area last reviewed under an
older version.

## Maturity levels

- **Lite** — the flywheel is written down ([`FLYWHEEL.md`](templates/FLYWHEEL.md))
  and misses are actually captured somewhere durable with a lever id and a
  taxonomy category; a reflection habit exists. Enforcement may be convention.
- **Standard** — misses live in a machine-readable [corpus](templates/corpus.yaml)
  where every entry has a **unique lever id**, a **valid taxonomy category**,
  and a **pinned pre-fix commit**, validated by [corpus-lint](reference/corpus-lint/)
  in CI; lenses are additive and numbered; reflection-proposed scaffolding
  changes require human approval; an [audit catalog](templates/AUDIT-CATALOG.md)
  gives every drift-prone area no gate covers a cadence, an owner and a
  last-audited date.
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
5. Turn on session reflection. With Jig's plugin, add a `reflection`
   section to the user configuration (`~/.jig/jig.yaml`, see the
   [plugin's configuration](../../plugin/CONFIGURATION.md#reflection)): the
   review loop then asks for [`/jig:reflect`](../../plugin/skills/reflect/README.md)
   after a hard review, and [`/jig:review-reflections`](../../plugin/skills/review-reflections/README.md)
   turns the store into approved changes. Without the plugin, copy
   [`reflection-inbox.md`](templates/reflection-inbox.md) and put the
   [reflection trigger](reference/reflection-trigger/) at the end of
   [M7](../M7-pr-lifecycle-review/)'s review loop, so a hard review prompts
   reflection at convergence rather than whenever someone thinks of it. Tune
   `ROUND_THRESHOLD` once you have seen a few fire.
6. Wire the reflection + memory-promotion steps to your runtime (recipes in
   [mappings.md](mappings.md)), keeping the human-approval checkpoint.
7. Copy [`AUDIT-CATALOG.md`](templates/AUDIT-CATALOG.md) and list the areas
   that drift without a gate noticing, each with an owner, a cadence and a
   last-audited date (`never` for an area not yet audited, which makes its
   first audit due at once); file one issue per `manual` row for the gap in
   tooling, or record in the row why its audit cannot be automated.
   Add the [deep-review tracker](templates/deep-review-tracker.md) if you run
   deep reviews. [mappings.md](mappings.md#audit-cadence-reminders) shows how
   to remind owners when a row goes overdue.

## Status

### Runnable form

Memory promotion runs as the
[`promote-memory`](../../plugin/skills/promote-memory/SKILL.md) skill in
Jig's [plugin](../../plugin/README.md): it checks that a private memory
still holds before lifting it into the team's git-tracked docs. The review
loop that feeds the reflection trigger runs as
[`drive-pr`](../../plugin/skills/drive-pr/README.md) (see
[M7](../M7-pr-lifecycle-review/README.md#status)). Session reflection runs as
[`reflect`](../../plugin/skills/reflect/README.md), which records a session's
findings in a shared store, and
[`review-reflections`](../../plugin/skills/review-reflections/README.md),
which turns them into changes a person approves. The store sits behind a
contract with a conformance suite; the plugin ships a filesystem store and a
Notion store, and runs any other store command. The reflection trigger and its markdown inbox
below remain the option for repositories without the plugin.

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/FLYWHEEL.md`](templates/FLYWHEEL.md) | The copyable process doc: the flywheel and its two companion cycles, with the human-approval boundary |
| [`templates/miss-taxonomy.yaml`](templates/miss-taxonomy.yaml) | A neutral, generic miss taxonomy to prune and grow |
| [`templates/corpus.yaml`](templates/corpus.yaml) | The eval-corpus schema, with a validated and an unvalidated example |
| [`templates/reflection-inbox.md`](templates/reflection-inbox.md) | The inbox the reflection trigger appends aggregable records to |
| [`templates/AUDIT-CATALOG.md`](templates/AUDIT-CATALOG.md) | The audit catalog: one row per drift-prone area no gate covers, with owner, cadence, tooling, last audited and open work |
| [`templates/deep-review-tracker.md`](templates/deep-review-tracker.md) | Optional: a versioned list of review dimensions and the re-reviews queued when it changes |
| [`reference/corpus-lint/`](reference/corpus-lint/) | The corpus invariants as a gate: unique lever ids, known categories, pinned commits, validate-then-gate |
| [`reference/parity-report/`](reference/parity-report/) | Recall, precision and `missed_blockers` per reviewer, failing on a missed blocker |
| [`reference/reflection-trigger/`](reference/reflection-trigger/) | Fires reflection from [M7](../M7-pr-lifecycle-review/)'s convergence line when a change took many rounds, and writes the record |
| [`mappings.md`](mappings.md) | Trackers for lever ids, eval runners, telemetry, per-runtime reflection and memory commands, audit-cadence reminders |
| [maturity criteria](../../plugin/skills/audit/criteria/M8-learning-loop.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Each reference gate ships with a self-test and fixtures, and delegates to the
shared implementation in [`lib/module-gates.ts`](../../lib/module-gates.ts);
keep the module and `lib/` together when you vendor them.

### Left out by design

- **A real taxonomy.** Miss categories and reviewer-tier names are one
  repository's tuned, product-specific content; the module ships a neutral
  taxonomy instead. Grow your own categories from your own misses.
- **An eval runner.** The code that replays a fixture through a model-based
  reviewer and diffs its findings is a model job best written in the target
  repository's own language, so the module specifies the corpus contract and
  ships only the pieces that are portable gates: the corpus invariants, the
  parity arithmetic and the reflection trigger.
- **Eval fixtures.** Real fixtures are product-specific and unproven until a
  live run validates them, so none are included.
- **A check on the catalog.** A script that flags an overdue row, or a
  `manual` row without an issue for its gap, is future: it is worth writing
  once a repository has kept a catalog long enough to show which failures
  recur, so the template states the rule and leaves the dates to the owners.
- **Telemetry wiring.** Event names and dashboards belong with
  [M11](../M11-process-observability/).
