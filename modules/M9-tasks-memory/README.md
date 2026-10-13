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

A third problem shows up once a tracker drives agents at volume: the rules
for *closing* and *filing* work decide whether the board stays readable. An
epic that closes only when it has no open children never closes, because
review follow-ups keep arriving as children, so open epics pile up while
almost none close. Follow-ups filed without a priority sink into a pool
nobody can rank. This module states the work-item rules that keep both
honest.

## Invariant

> Issues carry a **mandatory label taxonomy** — a closed set of types and
> statuses, plus **[flag labels](../../GLOSSARY.md) that each fire a process**
> (a migration flag fires a migration review; an API-change flag fires the
> contract gates; a `manual-ops` flag blocks *done* until an operator checklist
> is complete; a `security-sensitive` flag fires a security review; a `hitl`
> flag revokes autonomous execution/merge). A label that fires nothing is not
> allowed. Work is tiered **what** (the tracker, which holds all work state) /
> **how** (persistent agent memory about the code) / **in-session** (the task
> list and worktree scratch), and a
> durable lesson is **promoted** from private memory into git-tracked shared
> memory through a review point. Recurring multi-phase work runs a **formula**
> whose **required phases must be recorded before the item may close** (staging
> verification before production, say).
>
> Work items follow these rules. An **epic closes on an accepted verdict** that
> its designed scope is delivered, or on a recorded human waiver, never on its
> count of open children. A **flag that fires a gate goes on the item that
> ships the change**, never on its container. **Labels carry durable
> classification only**, never mutable operational state. Every issue is
> filed **with its priority and category already set**: the priority from
> one shared severity mapping, the category chosen and checked against one
> category list. **Every copy of the taxonomy's key sets is checked** for
> exact equality with its source. **Prioritization is computed**: the ranked
> shortlist is reproducible from a tracker snapshot and a committed weights
> file, and a person picks from it.

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
   with the taxonomy, plus each item's tactical plan, decisions and handoffs),
   *how* lives in persistent agent memory (durable knowledge about the code,
   private first and promoted into git-tracked docs), and *in-session* is the
   task list and worktree scratch an agent keeps for one focused stretch.
   Putting a lasting decision in the ephemeral tier is how knowledge
   evaporates; parking a handoff in worktree scratch hides it from every other
   worktree; a second store for work state beside the tracker drifts from
   it. The
   tiers and the handoff format are spelled out in
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
   a sub-issue, each stating its type, status, flags, priority and category,
   a tactical execution plan, and epic↔sub-issue links both ways, so a reader
   landing on either reaches the whole picture.

## Work-item rules

The rules below govern how items are filed, labelled and closed.

### An epic closes on an accepted verdict

An [epic](../../GLOSSARY.md) closes when its newest
[acceptance verdict](../../GLOSSARY.md) says its *designed scope* is delivered,
or when a person records a [waiver](../../GLOSSARY.md) on the epic. "Designed
scope is delivered" is a judgment, not a countable fact, so the count of open
children never decides closure. That count fails both ways: review follow-ups
keep arriving as children, so an epic that waits for zero open children never
closes; and sub-issues marked done whose code never landed would let an epic
close on a count that looks complete.

- A waiver answers "nobody ran the review", never "the review said no": it
  cannot override a rejecting verdict. An accepting verdict that a later
  rejection superseded does not count either.
- Findings deferred while the epic is live still go to the epic, where its
  owner sees them.
- At closure, the epic hands off its [tails](../../GLOSSARY.md): open
  children it was never scoped to finish, such as a legal sign-off, an
  operator step or review debt. Each tail is linked back to the epic and given a
  comment naming where it came from, and only then unparented and moved to
  the standing destination for its kind. The flag it carries, the link and
  the comment are what make the unparenting safe: the item still shows where
  it came from.
- An open child that is ordinary scope means the designed scope is not
  delivered, and the epic stays open.
- An epic that itself owes an operator step parks in a waiting state; it does
  not close until the step is done.

### Gate flags go on the shipping item

A flag that fires a gate goes on the work item whose change ships, the
sub-issue whose pull request carries the migration, never on the epic that
contains it. On the epic, the gate fires for every child or for none; on the
child, it fires exactly where the change is. `epic` is itself a flag, not a
type: an epic keeps its real type, so an epic of fixes stays a `bug` and
every rule that reads the type still sees it. Each flag in the
[taxonomy](templates/label-taxonomy.yaml) declares its `scope`
(`shipping-item` or `container`) so this rule is checkable per flag.

### Labels carry durable classification only

A label records a fact about the item that stays true: what kind of work it
is, which process it fires. It never records operational state that changes
while the item lives.

- "This change will need an out-of-tree step" is a flag. "That step is
  pending now" is state, and belongs in the tracker's status or an
  operations ledger. Reading the first as the second makes every later sweep
  re-triage the same items.
- Who can perform a step and who must approve it are separate facts. "Only a
  person can do this" is durable and can be a label; "a person has to approve
  this in production" changes as approvals are granted, so it is ledger
  state, not a label.
- Flags stay on after the step is done: they record that the item owed one.

### Priority and category at birth

Every path that files an issue (a person, a review's deferral, a scheduled
check, an agent) sets its priority and category when it files it. The
priority is derived from one shared [severity mapping](../../GLOSSARY.md).
The category is a separate classification, since two findings of the same
severity can be a security issue and a performance one: the filing path takes
it from the finding and checks it against one category list, never derives it
from severity. A finding that came with no category is filed as an explicit
`unknown`, which the check accepts, rather than with a guessed one. That list
is kept beside the label taxonomy, not in it (the taxonomy's schema holds
types, statuses and flags only); where Jig's tooling reads it is in
[mappings.md](mappings.md#issue-trackers--the-work-item-rules). Before
writing, the filing path validates the mandatory taxonomy (type and the other
required groups), and appends to an existing container when one fits instead
of filing a new one.
An issue filed without a priority is not "low priority"; it is unranked, and
an unranked pool cannot be worked in order.

### Taxonomy copies are checked

Any copy of the taxonomy's key sets outside its source file (the type list a
configuration repeats, the label names a skill is configured with, a list in
a planning template) is checked for exact equality with the source. Exact,
not subset: a key added on one side only fails in both directions. A copy
nothing checks drifts the first time someone edits the source.

### Computed prioritization

The ranked shortlist of what to work on next is reproducible: the same
tracker snapshot and the same committed weights file give the same ranking. A
judgment layer may reorder it only with a stated reason per deviation; a
deviation that recurs is a weight to retune. A person picks from the
shortlist.

## Maturity levels

- **Lite** — a documented issue taxonomy exists (types, statuses, and named
  flag labels), flag labels are named by convention, and a persistent-memory
  location is designated (by convention). Enforcement may be prose and habit.
- **Standard** — the taxonomy is a validated SSoT file and the
  [label-taxonomy lint](reference/label-taxonomy-lint/) runs mechanically; flag
  labels actually **fire gates** (a `has-migration` label triggers a required
  check, a `hitl` label is honoured), each declaring its scope so gate flags
  sit on the shipping item; epics close on an accepted verdict or a recorded
  waiver, never on a child count; every filing path sets priority and category
  at birth; and the memory-promotion path from private to git-tracked shared
  memory is documented.
- **Strict** — both gates run in [CI](../../GLOSSARY.md) with self-tests
  (mechanical); required-phase **formulas gate item closure** mechanically (an
  item cannot close with a required phase unrecorded); and the `hitl` flag
  mechanically **revokes autonomous execution/merge** (shared with
  [M7](../M7-pr-lifecycle-review/)).

## Adoption steps

1. Copy [`label-taxonomy.yaml`](templates/label-taxonomy.yaml); prune the types
   and statuses to what your tracker uses and declare, for each flag, the process
   it fires, which item carries it (`scope`) and when it applies
   (`apply_when`). Add the [label-taxonomy lint](reference/label-taxonomy-lint/)
   as a CI gate so the taxonomy can't drift into folksonomy, and check every
   copy of its key sets elsewhere against it.
2. Wire each flag to its process: point `has-migration` / `api-change` at your
   [M3](../M3-change-area-catalog/) required-checks projection, and the `hitl`
   flag at the same autonomy-revoking rule [M7](../M7-pr-lifecycle-review/) and
   [M0](../M0-instruction-architecture/) use (recipes in [mappings.md](mappings.md)).
3. Adopt [`ISSUE-TEMPLATES.md`](templates/ISSUE-TEMPLATES.md) as your tracker's
   epic and sub-issue templates so every issue carries the taxonomy, its
   priority and category, and a tactical plan.
4. Designate the three memory tiers with [`MEMORY-TIERS.md`](templates/MEMORY-TIERS.md):
   a git-tracked shared-memory home, the agent-runtime memory feature for the
   *how* tier, and the promotion step (kept HITL, wired with [M8](../M8-learning-loop/)).
5. Write the [work-item rules](#work-item-rules) into your instructions:
   the epic closure rule and where its tails go, and the one severity mapping
   every filing path derives priority from.
6. For any recurring multi-phase work, write a [`phase-formula.yaml`](templates/phase-formula.yaml)
   and add the [required-phases gate](reference/required-phases/) at close/merge
   so a required phase can't be skipped.

## Status

### Runnable form

Skills in Jig's [plugin](../../plugin/README.md) run parts of this
practice:

- [`do-item`](../../plugin/skills/do-item/SKILL.md) picks up a work item
  through a [tracker adapter](../../GLOSSARY.md) and honours its flag labels:
  `hitl` stops it before delegating and keeps the merge human, and
  `manual-ops` surfaces the operator checklist and parks the item until a
  person completes it. When an epic's only open children are tails, it
  extracts them and closes the epic only on an accepting verdict or a
  recorded waiver, and an epic that owes an operator step parks instead of
  closing. The label names and the tracker's state names are
  configuration (`issue_tracker.labels`, `issue_tracker.states` in the
  [configuration reference](../../plugin/CONFIGURATION.md#issue_tracker));
  the template's statuses are the same canonical states.
- [`resolve-review-comments`](../../plugin/skills/resolve-review-comments/SKILL.md)
  files a deferred review finding with its priority set from the severity
  mapping, refuses a type outside the declared taxonomy or a missing
  mandatory label group, and appends to the open follow-up for the same pull
  request and type instead of filing another.
- [`drive-pr`](../../plugin/skills/drive-pr/SKILL.md)'s scoreboard
  (`fractal-metrics.ts`) reads the follow-up ledger through the tracker
  adapter and reports the share of open follow-ups that carry no priority.
- The [audit](../../plugin/skills/audit/README.md)'s configuration check
  compares the configured `issue_tracker.labels` and `review.taxonomy.types`
  with a repository's `label-taxonomy.yaml`, so an audit run reports where
  those copies of the taxonomy have drifted from it.
- [`promote-memory`](../../plugin/skills/promote-memory/SKILL.md) is the
  promotion step between the memory tiers, shared with
  [M8](../M8-learning-loop/).

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/label-taxonomy.yaml`](templates/label-taxonomy.yaml) | A generic label taxonomy: closed types and statuses, and flags that each declare what they fire, which item carries them and when they apply |
| [`templates/ISSUE-TEMPLATES.md`](templates/ISSUE-TEMPLATES.md) | Tool-independent epic and sub-issue skeletons carrying the taxonomy, priority and category, and a tactical plan |
| [`templates/phase-formula.yaml`](templates/phase-formula.yaml) | The formula schema: a work class's phases, with the required ones marked |
| [`templates/MEMORY-TIERS.md`](templates/MEMORY-TIERS.md) | The what / how / in-session tiers and the private → promoted → git-tracked flow |
| [`reference/label-taxonomy-lint/`](reference/label-taxonomy-lint/) | The taxonomy's invariants as a gate: closed lists, no flag that fires nothing, and every flag scoped and conditioned |
| [`reference/required-phases/`](reference/required-phases/) | The close-time gate: an item may not reach a done state with a required phase unrecorded |
| [`mappings.md`](mappings.md) | Issue trackers, persistent-memory homes, CI providers |
| [maturity criteria](../../plugin/skills/audit/criteria/M9-tasks-memory.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Each reference gate ships with a self-test and fixtures, and delegates to the
shared implementation in [`lib/module-gates.ts`](../../lib/module-gates.ts);
keep the module and `lib/`, its `vendor/` folder included, together when you
vendor them. The label-taxonomy lint reads the taxonomy with the js-yaml build
in `lib/vendor/`, which rejects a repeated key.

### Left out by design

- **Real label names, trackers and memory tools.** A working repository's
  label names, its phase catalogue and its choice of tracker and memory store
  are its own content. The module provides the *shapes* (a flag fires a
  process; three memory tiers; a formula's required phases gate closure) with
  neutral labels and examples, and lists named trackers and memory stores in
  [mappings.md](mappings.md) as options, never requirements.
- **The promotion and reflection commands.** They belong with
  [M8](../M8-learning-loop/).
- **Tracker-to-gate automation.** It is per ecosystem and lives in
  [mappings.md](mappings.md).

### Future

- **The epic acceptance review, the tail sweep and the prioritization
  ranker** as runnable skills. The rules above are stated now; the tools that
  run them (a review that writes the accepting verdict, a sweep that extracts
  tails and closes the epic, and a ranker over a tracker snapshot and a
  weights file) are planned to move into the plugin. Until then `do-item`
  asks for the verdict or waiver and stops without one.
