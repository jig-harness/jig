# M9 — Tasks & memory

**What problem this solves.** Two everyday things quietly rot a delivery
process. First, a task tracker that is *just a list* does not drive anything:
labels accumulate as decoration (a folksonomy — tags people add by habit that
mean whatever the reader guesses), so "this touches a database migration" or
"this needs a human to merge" is a note someone might notice, not a step that
reliably happens. Second, an agent's knowledge **evaporates between sessions**:
the plan it built, the gotcha it hit, the decision it made all vanish when the
window closes, so the next session — or the next agent — starts cold and repeats
the work or the mistake. This module makes the tracker *drive* process (labels
that fire gates) and gives agent knowledge a place to live (a tiered memory with
a promotion path), plus reusable **phase formulas** so recurring multi-phase
work can't skip a required step on the way to done.

## Invariant

> Issues carry a **mandatory label taxonomy** — a closed set of types and
> statuses, plus **[flag labels](../../GLOSSARY.md) that each fire a process**
> (a migration flag fires a migration review; an API-change flag fires the
> contract gates; a `manual-ops` flag blocks *done* until an operator checklist
> is complete; a `security-sensitive` flag fires a security review; a `hitl`
> flag revokes autonomous execution/merge). A label that fires nothing is not
> allowed. Work is tiered **what** (the tracker) / **how** (persistent
> multi-session agent memory) / **in-session** (an ephemeral task list), and a
> durable lesson is **promoted** from private memory into git-tracked shared
> memory through a review point. Recurring multi-phase work runs a **formula**
> whose **required phases must be recorded before the item may close** (staging
> verification before production, say).

Everything below is that one tool-independent statement made mechanical;
concrete per-tracker, per-runtime wiring lives in [mappings.md](mappings.md).

## Core pieces

1. **Flag labels as process triggers, not folksonomy** — the label set is a
   validated [SSoT](../../GLOSSARY.md) ([`label-taxonomy.yaml`](templates/label-taxonomy.yaml))
   with a closed `types` list, a closed `statuses` list, and `flags` where every
   entry declares what it **fires**. A flag with no trigger is decoration, and
   the [label-taxonomy lint](reference/label-taxonomy-lint/) rejects it. Many
   flags are *derivable* rather than hand-applied: if a change touches a
   migration path in the [M3](../M3-change-area-catalog/) change-area catalog,
   the migration flag can be set automatically.
2. **The three memory tiers** — *what* lives in the tracker (team-visible units
   with the taxonomy), *how* lives in persistent multi-session agent memory (the
   tactical plan, decisions, gotchas — git-backed so it survives a session), and
   *in-session* is the ephemeral task list an agent keeps for one focused
   stretch and then discards. Putting a lasting decision in the ephemeral tier is
   how knowledge evaporates; the tiers are spelled out in
   [`MEMORY-TIERS.md`](templates/MEMORY-TIERS.md).
3. **Memory promotion** — private, per-session agent memory becomes reliable for
   the whole team only when a durable lesson is **promoted** into git-tracked
   shared memory through a review point (never an automatic dump). This is the
   [HITL](../../GLOSSARY.md) memory-promotion flow shared with
   [M8 — Learning loop](../M8-learning-loop/), which pairs it with session
   reflection: M9 owns *where* memory lives, M8 owns the *promote/reflect loop*.
4. **Phase formulas with REQUIRED gates** — a [`phase-formula.yaml`](templates/phase-formula.yaml)
   encodes the phases a *class* of recurring work must pass and marks which are
   `required: true`. The [required-phases gate](reference/required-phases/)
   refuses to let an item reach a done state with a required phase unrecorded —
   the same validate-then-gate shape as [M8](../M8-learning-loop/)'s corpus,
   applied to a work item's lifecycle.
5. **Epic / issue templates carrying the taxonomy** — copyable, tool-independent
   [`ISSUE-TEMPLATES.md`](templates/ISSUE-TEMPLATES.md) skeletons for an epic and
   a sub-issue, each stating its type, status, and flags, a tactical execution
   plan, and epic↔sub-issue links both ways, so a reader landing on either
   reaches the whole picture.

## Maturity levels

- **Lite** — a documented issue taxonomy exists (types, statuses, and named
  flag labels), flag labels are named by convention, and a persistent-memory
  location is designated (by convention). Enforcement may be prose and habit.
- **Standard** — the taxonomy is a validated SSoT file and the
  [label-taxonomy lint](reference/label-taxonomy-lint/) runs mechanically; flag
  labels actually **fire gates** (a `has-migration` label triggers a required
  check, a `hitl` label is honoured); and the memory-promotion path from private
  to git-tracked shared memory is documented.
- **Strict** — both gates run in [CI](../../GLOSSARY.md) with self-tests
  (mechanical); required-phase **formulas gate item closure** mechanically (an
  item cannot close with a required phase unrecorded); and the `hitl` flag
  mechanically **revokes autonomous execution/merge** (shared with
  [M7](../M7-pr-lifecycle-review/)).

## Adoption steps

1. Copy [`label-taxonomy.yaml`](templates/label-taxonomy.yaml); prune the types
   and statuses to what your tracker uses and declare, for each flag, the process
   it fires. Add the [label-taxonomy lint](reference/label-taxonomy-lint/) as a
   CI gate so the taxonomy can't drift into folksonomy.
2. Wire each flag to its process: point `has-migration` / `api-change` at your
   [M3](../M3-change-area-catalog/) required-checks projection, and the `hitl`
   flag at the same autonomy-revoking rule [M7](../M7-pr-lifecycle-review/) and
   [M0](../M0-instruction-architecture/) use (recipes in [mappings.md](mappings.md)).
3. Adopt [`ISSUE-TEMPLATES.md`](templates/ISSUE-TEMPLATES.md) as your tracker's
   epic and sub-issue templates so every issue carries the taxonomy and a
   tactical plan.
4. Designate the three memory tiers with [`MEMORY-TIERS.md`](templates/MEMORY-TIERS.md):
   a git-tracked shared-memory home, the agent-runtime memory feature for the
   *how* tier, and the promotion step (kept HITL, wired with [M8](../M8-learning-loop/)).
5. For any recurring multi-phase work, write a [`phase-formula.yaml`](templates/phase-formula.yaml)
   and add the [required-phases gate](reference/required-phases/) at close/merge
   so a required phase can't be skipped.

## Port status

| Source (docomply `develop`) | Landed as |
|-----------------------------|-----------|
| tracker label taxonomy (types/statuses + flag labels that drive process) | [`templates/label-taxonomy.yaml`](templates/label-taxonomy.yaml) + [`reference/label-taxonomy-lint/`](reference/label-taxonomy-lint/) — a **generic** taxonomy (docomply-specific label names IP-scrubbed out) and its invariant gate + self-test |
| planning templates (epic + issue skeletons with tactical plans) | [`templates/ISSUE-TEMPLATES.md`](templates/ISSUE-TEMPLATES.md) — tool-independent epic/sub-issue skeletons carrying the taxonomy |
| phase "formulas" encoding required phases for a work class | [`templates/phase-formula.yaml`](templates/phase-formula.yaml) + [`reference/required-phases/`](reference/required-phases/) — the formula schema and a close-time gate + self-test |
| the what/how/in-session tiering + memory-promotion flow | [`templates/MEMORY-TIERS.md`](templates/MEMORY-TIERS.md) — the tiers and the private→promoted→git-tracked flow, cross-linked with [M8](../M8-learning-loop/) |

Also landed: [`mappings.md`](mappings.md) (issue trackers, persistent-memory
homes, CI) and [`maturity.yaml`](maturity.yaml).

**Not ported** (per "don't port the unproven" / IP scrub): the reference
implementation's actual (domain-specific) label names, its specific trackers and
memory tools, and its private phase catalogue are product-domain content —
groundwork ports the *shapes* (a flag fires a process; three memory tiers; a
formula's required phases gate closure) with neutral generic labels and
examples, and treats named trackers/memory stores as options in
[mappings.md](mappings.md), never requirements. The actual promotion/reflection
*commands* belong with [M8](../M8-learning-loop/); the tracker-to-gate
automation wiring is per-ecosystem and lives in [mappings.md](mappings.md).
