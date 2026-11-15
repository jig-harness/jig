# The epic planner: design

**What problem this solves.** An [epic](../GLOSSARY.md)'s children run in
parallel only when the epic carries an
[execution plan](../GLOSSARY.md): the `execution-plan-v1` block in its
description that the pickup and the dispatcher read. Nothing in Jig writes
that block. Without it, the dispatcher starts an epic's children without
knowing their real order (one at a time, or up to a fixed width), an order
lives in prose a reader cannot check, and a blocker in the tracker can
disagree with the plan without anyone noticing. A plan written by hand also
goes out of date the moment the epic changes: a child is added, merged or
canceled, and nothing works out the order again. With this built,
`/jig:plan-epic <epic>` reads the epic and its children through Jig's
tracker interface, records each real dependency as the tracker's own
relation, and writes the plan section with its block. Running it again keeps
the plan current: the mechanical changes apply on their own, and the
changes that need judgment wait for one approval from a person.

This is the design of [plan.md](plan.md) item 56. Nothing of the planner is
built in Jig yet. The reader side is:
`plugin/skills/do-item/scripts/lib/execution-plan.ts` (the format
contract, which refuses any field it does not know),
`select_execution_issue.ts` (the pickup's choice of the next child),
`plugin/dispatch/lib/sources/served-plan.ts` (the dispatcher's) and
`tracker.ts sync-plan-blocks`, which copies a plan's dependency edges into
native `blocks` relations
([ADR-0015](../docs/adr/ADR-0015-relationships-live-in-the-tracker.md)).

## Where the planner comes from

A [consumer repository](../GLOSSARY.md) operates the planner as a skill: a
command-line program with its library and tests, and the instructions for
the session that runs it. It reads and writes one tracker, Linear, through
its own client. Jig brings it in by moving it, not by writing a new one
([AGENTS.md](../AGENTS.md), "move, never copy"): the files come with their
tests, and the consumer's copy is deleted in the same rollout.

The planner splits its work strictly in two:

| Mechanical: the script | Judgment: the session that runs it |
| --- | --- |
| Read the epic and its children, and fail closed on a listing it could not read to the end | Which children are obsolete, duplicates or already done |
| Find what is wrong: cycles, blockers that are stale, outside the epic or reversed, missing sizes, a plan out of date | Which order between two children is real, and in which direction |
| Work out the priorities from one rule | The lanes, the batches and the one-line intent |
| Render the plan section, its step table and its dated stamp | A priority that departs from the rule, with its reason |
| Compare the plan with the tracker, list the changes, apply them, check them again | Showing the changes that need approval to a person |

A **lane** is a group of related children, named for the reader; being in
one lane orders nothing. A **human gate** is a step that waits on a person
before an agent may start it. A **precedence band** is a step's depth in the
order: band 1 waits on nothing in the plan, and a step in band 2 or later
waits only on its own predecessors and live blockers, so a band is a depth,
never a barrier that every earlier step must clear.

Its workflow, which moves unchanged:

1. **Snapshot and lint.** `snapshot` reads the epic, every child and each
   child's relations, also to issues outside the epic. `lint` lists what is
   wrong. An error, such as a cycle, stops the planning.
2. **Read.** The session reads the description and the comments of the epic
   and of each open child, since scope often moved into a comment.
3. **Judge.** `init-plan` writes a skeleton `plan.json` that keeps every
   live blocker and recovers the last plan's intent, lanes, edge reasons,
   batches and notes. A live blocker the last plan did not hold gets a
   `TODO` reason that the next step refuses until someone gives a real one.
   The session edits the file: closures, edges with their reasons, lanes,
   overrides, human gates, notes.
4. **Propose.** `propose` refuses a plan that does not fit the snapshot (a
   child in no lane, a cycle, an edge onto an issue that is closing, a
   leftover `TODO`) and lists every problem at once. Its output is the
   changeset, the list of writes the plan needs, in two parts. *Applies on
   its own*: writing a planned blocker, removing a blocker whose source was
   canceled, and rendering the planner's own section. *Needs approval*:
   every closure, every priority change, removing a live blocker the plan
   dropped, and replacing a plan section the planner did not write.
5. **Apply.** `apply` reads the tracker again before it writes, so it never
   starts from a stale picture. Between that read and the last write the
   tracker port offers no transaction, so the guarantee covers what the epic
   held at the read: `apply` writes in a fixed order (relations, then
   priorities, then closures, the epic's description last), and before each
   write revalidates what that write touches against the approved snapshot:
   the epic's version, and the target issue and the relation as read. An
   issue's own `updatedAt` is optional on the tracker port and no aggregate
   epic version covers a child's change, so a target whose evidence is
   missing or has moved stops the run: it fails closed rather than writing
   over a stale closure, priority or relation. Each write the run itself
   completes advances the expected state of what it touched by that
   mutation alone: the expected state becomes the approved snapshot with
   the intended field changed. `apply` then reads the target back and
   verifies the read against that expected state, and any difference the
   mutation does not explain stops the run instead of becoming the new
   baseline. The tracker port's mutations return nothing that attributes a
   read-back to this run, so the read-back is a check, never the
   evidence: a child's relation write followed by its priority write is
   not mistaken for a concurrent edit, and a person's change between the
   two still mismatches. The target's `updatedAt` moves with every write
   and cannot tell this run's write from another's, so the check compares
   the fields the planner reads and never takes a timestamp as the
   approved one. It stops at the first
   mismatch and reports what it wrote and what is left. A run stopped halfway is
   recovered by running the planner again, whose proposal reads the tracker
   as it now is. The approval is a digest, a hash of the rows
   the person saw: when the epic or the plan has moved since, the digest no
   longer matches and nothing is written. A declined row is an edit to
   `plan.json` and a new proposal, never a partial apply, because a partial
   apply would leave the section describing a state the tracker does not
   have. After writing, `apply` checks the result and reports what is left.
   Each run that writes leaves one audit comment on the epic, and each
   closure leaves its reason on the closed issue.
6. **Report.** What changed, what waits for approval and the gaps found.

`sweep` ranks every open epic by the health of its plan (no plan, a plan
older than its threshold, lint findings by severity), read-only.

**The priority rule.** An open child on the
[critical path](../GLOSSARY.md) (the longest chain of children, each
weighted by its size) takes the epic's priority; every other open child sits
one step below it, never below the lowest; an override in `plan.json`, with
its reason, replaces the rule for that child; and a blocker is never less
urgent than what it blocks, applied after the overrides.

**Idempotency without comparing text.** A tracker rewrites Markdown when it
saves it. The section therefore ends with a stamp (`plan-epic:v2 planned=…
structure=… render=…`) that holds a hash of what was rendered and a hash of
the planned structure (the open children, their sizes, their human gates
and the blockers that touch them). The section is rendered again only when
the render hash differs, and `lint` reports the plan stale when the
structure hash no longer matches the tracker.

## How it works

### What moves as it is, and what is reshaped

| Part | On the way in |
| --- | --- |
| The graph: cycles, precedence bands, the size-weighted critical path, ties broken by key | Moves as it is |
| The strict `plan.json` parser, its schema document and its reasons | Moves as it is, with keys of every tracker (`ENG-12`, `#12`) instead of one key shape |
| Lint, the changeset and its two parts, the approval digest, apply and its check afterwards, the audit comment | Moves as it is |
| The renderer and the stamp | Moves as it is, the stamp unchanged, so a section the consumer's copy wrote stays the planner's own; the graph (a Mermaid diagram) is drawn only where the tracker renders Mermaid, and the step table always carries the links |
| The priority rule | Moves as it is, written through the priority facet's store ([tracker-facets.md](tracker-facets.md)); the declared priorities that Task 4 of #1177 designs decide whether a ranker reads the rule or replaces it |
| `sweep` | Moves as it is, over the repository's tracker scope |
| The tracker client | Replaced by Jig's tracker interface (below) |
| Its own copy of the `execution-plan-v1` writer | Joins Jig's format module, which stays in `plugin/skills/do-item/scripts/lib/execution-plan.ts`; the planner imports it by its sibling path, as `file-issue` imports the tracker, so one module holds the reader and the writer and nothing under `plugin/shared/` imports a skill |
| Fixed label names (`hitl`, `manual-ops`, `epic`, the area label prefix) | Read from `issue_tracker.labels` and the change-area catalog's tracker labels |
| The check that an operator's step after a merge is complete, read from the consumer's own ledger of out-of-tree work | Becomes an optional command the repository declares (`plan_epic.ops_check_command`), as #303 records; Jig keeps no such ledger ([LIFECYCLE.md](../docs/LIFECYCLE.md), ops drain). The command runs without a shell, gets the child's key as its one argument, has a bounded run time, and prints one JSON line `{"complete": true|false, "evidence": "<text>"}`; only `complete: true` with evidence lets the planner propose the closure, as an approval row. Any other result (`false`, an empty or malformed line, a non-zero exit, a timeout) keeps the child open and is reported. Without the command, a child waiting on an operator step is never closed by the planner |
| The handoff from filing: comments that carry a filing's judgment before the children have keys | Moves as it is, read only; a later step has `/jig:file-issue` write it |
| The batch candidates it records | Read from the plugin's own `work-batch` proposal |
| Its exit codes | Renumbered so that none collides with the tracker's failure classes (exit 5 to 11, [do-item](../plugin/skills/do-item/SKILL.md#tracker-operations)), which pass through unchanged; the consumer's instructions that read them switch in the same rollout |
| The team it reads by default, its issue keys in comments, test names and test data, its own frontmatter and metadata | Removed: the team comes from `issue_tracker.team`, the examples become neutral, and the skill carries Jig's frontmatter |

### Through Jig's tracker interface

The planner reads and writes only through the tracker port
(`plugin/skills/do-item/scripts/lib/tracker/port.ts`), so it works on
GitHub Issues, Linear and Jira alike.

| What it needs | The port today |
| --- | --- |
| The epic, its children read to the end, each with its state, labels, type, size and priority | `getIssue`, `listChildren`, `issuesByKeys` |
| Each open child's relations both ways, outside the epic too | `listRelations` |
| Comments | `listComments` |
| Write a `blocks` relation | `relate` |
| Remove a `blocks` relation the plan dropped, or whose source was canceled | Missing: a new `unrelate`, one native removal per adapter |
| Close a child as done or canceled, or as a duplicate of another issue | `transition`, `relate(…, "duplicate", …)` |
| Change a priority | `updateIssue` with `priority`, through the facet store |
| Write the epic's plan section | `updateIssue` with `description` |
| Post the audit comment and each closure's reason | `postComment` |

The planner adds no call of its own: each read and write is an adapter
call, and gains each obligation of
[ADR-0021](../docs/adr/ADR-0021-outbound-calls-are-governed.md) as that
adapter's transport does (plan item 55). Within that, it reads one snapshot
per run and reuses it until `apply`, which reads one more; one epic costs
one snapshot, and `sweep` pages through the tracker scope; a tracker
failure stops the run with the failure's class, and a run with no answer
writes nothing and says which read failed.

### Dependencies first, as the tracker's own relations

Each real dependency is a native `blocks` relation before it is anything
else, and the plan keeps its edges and mirrors them, as
[ADR-0015](../docs/adr/ADR-0015-relationships-live-in-the-tracker.md)
decides. `apply` writes the relations first and renders the section after
them, and the block's dependency edges are exactly the relations it has
just written and read back. The block is thus derived on every run from the
tracker's state and `plan.json`, and never edited by hand. `plan.json` adds
what has no native form: conflict edges, lanes, human gates and each edge's
reason.

A person who changes the relations by hand between runs makes the plan
stale, and the next run treats the change as judgment. A `blocks` relation
the plan does not hold comes back from `init-plan` with a `TODO` reason, and
a relation removed by hand is a dropped edge, an approval row. Until that
run, the reader's check holds: a relation that contradicts the plan's order
makes the dispatcher hold the epic and name both issues, and #1144 raises
the need that names the planner as the remedy. `tracker.ts
sync-plan-blocks` stays for plans the planner did not write. On a planned
epic it finds nothing to write; a person who removed a relation re-runs the
planner instead, since `sync-plan-blocks` would write the plan's edge back.

The block is written where today's readers need one: the pickup and the
dispatcher read the block for the plan's own facts (bands, lanes, human gates
and edge reasons) and the native relations for what blocks a child, and they
refuse a block that contradicts the relations. Every planned epic gets a
block. When the readers take the plan's edges from the relations alone
(ADR-0015's open alternative), the block keeps only what has no native form.

### Plans default to parallel

Children run in parallel unless something real orders them. The planner
adds an edge only for a dependency (one child needs what another delivers)
or a severe overlap: both change the same mutable data or operator state,
both touch an area the change-area catalog marks `serialize`, or both
rewrite the same structure. Ordinary overlap, two children that touch some
of the same files, gets no edge: the dispatcher's admission weighs it
against waiting (#1179).

### Holds and order as relation statements

The planner authors every hold and every order it reports as a
[relation statement](../GLOSSARY.md): its subject references, a relation
word, its object references and a count, as in "these items wait on that
item", with an optional `reason`. Every reference carries its kind (issue or pull request), its key,
its state, its link and its counterpart: an issue's pull request, or a pull
request's issue. A view can then show each reference as a chip with its
link and a hover panel without reading prose.

```json
{
  "subjects": [
    { "kind": "issue", "key": "#41", "state": "todo", "url": "https://github.com/acme/app/issues/41", "counterpart": null },
    { "kind": "issue", "key": "#42", "state": "todo", "url": "https://github.com/acme/app/issues/42", "counterpart": null }
  ],
  "relation": "waits on",
  "objects": [
    { "kind": "issue", "key": "#40", "state": "pr_open", "url": "https://github.com/acme/app/issues/40",
      "counterpart": { "kind": "pull-request", "key": "#57", "state": "open", "url": "https://github.com/acme/app/pull/57" } }
  ],
  "count": 2
}
```

The relation words are a closed list:

| Relation | Subjects | Objects |
| --- | --- | --- |
| `waits on` | the children that wait | the issues they wait on, inside or outside the epic |
| `must not run with` | the children of a conflict edge | the other side of the edge |
| `waits for a person` | the gated children | `[]`; the gate's reason is in `reason` |
| `is not in the plan` | the open children the plan leaves out | the epic |

The count is the number of subjects, so a view can fold them ("2 items
wait on #40"). The planner computes the statements from the snapshot and
`plan.json` on each run, prints them in its JSON output and renders the
section's prose and step table from them; none is stored apart from the
tracker and the plan. The overview that Task 4 of #1177 designs reads the
same function.

### Footprints and the steps that wait on a person

Each step can declare its [footprint](../GLOSSARY.md): the paths it is
expected to touch, as globs. The planner is one of the writers of the
footprint record that the design of #1179 defines, and writes it where that
design keeps it. A footprint never goes into the block, whose reader refuses
a field it does not know, and this design adds no store of its own.

A step that waits on a person is a human gate. A `hitl` label always makes
one, and `plan.json` adds one, with its reason, for a child without the
label. A plan cannot cancel a `hitl` label.

### Keeping a plan current

The structure hash says when an epic's shape has changed since its plan
was written: a child added, closed or resized, a blocker added or removed, a
human gate changed. A plan run then follows the same split as the first
one:

- **Mechanical, applied without asking**: writing a blocker the plan
  records, removing one whose source was canceled, rendering the section
  again, and placing a new child with no relation to its siblings in a lane
  of its own with no edge, since plans default to parallel, but only after
  the session's independence assessment: it has read the child's description
  and comments and found no dependency or overlap with an open sibling. A
  child it has not assessed is held as a human gate until it has been, so an
  open step with no blocking edge never becomes eligible unexamined. The
  report names each child placed this way, so a person can give it an edge.
- **Judgment, approved first**: a closure, a priority change, dropping a
  live blocker, an edge for a new child, replacing a section the planner did
  not write. A new child's priority from the rule is a priority change like
  any other: the child is placed at once, and its priority waits for the
  approval unless it already has the rule's value. A dispatched pass can
  place the child and render the section before the approval, because both
  are in the applied part of the changeset; the pending rows (a priority or
  an edge) are left out of the plan and the renderer entirely, and the parked
  digest approves the complete resulting state, so no partial state is ever
  rendered. A child with a pending edge or priority row is held as a human
  gate from the moment it is placed, whatever the assessment found, and the
  hold is removed only when the approved resulting plan is applied: leaving
  the edge out of the rendered plan must never make the child eligible
  before the approval, since nothing else blocks it.

Who runs the planner: a person, with `/jig:plan-epic <epic>`, or a
dispatched pickup of an issue assigned to the factory identity whose work
is planning an epic, such as an item of #1177's backfill wave. The
dispatcher does not start a planner pass by itself. A dispatched pass
nobody can approve applies the mechanical rows and stops on the rest, the
way any dispatched pass stops on a decision: it records the rows and their
digest as one parked decision with two options, approve as shown or amend
([structured-answers.md](structured-answers.md)), which a person answers in
a word. Until step 6 of the build order, that decision is a plain question
naming the digest; from step 6, an approval writes only under that digest,
so one given after the epic moved again writes nothing. The pass started on that answer proposes
once more and parks once more when the rows changed, and after a second
mismatch it reports the epic as moving too fast to plan unattended and asks
a person to run the planner.

An open child the plan leaves out is never a silent wait. The planner's
`lint` reports it, and the dispatcher's side raises one need for the epic,
naming the planner as the remedy (#1144).

### Its place in the delivery loop

The "plan the epic" stage of [docs/LIFECYCLE.md](../docs/LIFECYCLE.md)
names `/jig:file-issue` today. When the planner moves in, the row becomes:

| Stage | Owner | Hands on | Detail |
| --- | --- | --- | --- |
| plan the epic | `/jig:file-issue` splits an issue into sub-issues and their relations; `/jig:plan-epic` orders them, and is run again whenever the epic's shape moves | an epic of ordered, labelled sub-issues whose dependencies are native relations, with its execution plan | the plan-epic skill's README, [M9](../modules/M9-tasks-memory/README.md) |

Upstream, `/jig:file-issue` files the epic and its children. Downstream,
`/jig:do-item`, `/jig:work-batch` and the dispatcher pick up children in
the order the relations and the block allow. The epic closes on an
[acceptance verdict](../GLOSSARY.md), as `/jig:do-item` checks today. The
row changes in the pull request that moves the planner, not before, so that
the lifecycle never names a skill that does not exist.

### Configuration

The move adds a `plan_epic` section to `.config/jig.yaml`, documented in
[CONFIGURATION.md](../plugin/CONFIGURATION.md) and in the audit's
`config-schema.yaml`: the optional `ops_check_command` above, and the age
after which `lint` calls a plan old (`max_plan_age_days`, default 30). The
size weights of the critical path (extra small 1, small 2, medium 4, large
8, extra large 16) read the size facet's values and stay fixed. Every
other value comes from settings that exist: `issue_tracker.*`,
`do_item.execution_plan_block` and the change-area catalog.

### The licence of the moved code

The holder of the planner's copyright granted on 2026-11-14 that the
planner moves into Jig under Jig's licence, the Apache License 2.0. The
moved code arrives as a contribution, like any other change, under the
[Developer Certificate of Origin](../GLOSSARY.md). [NOTICE](../NOTICE)
lists only the templates under MIT No Attribution and the third-party code
Jig vendors. The planner is neither, so NOTICE gains no entry. The pull
request that moves the planner repeats the grant in its description.

## Build order

One pull request per step. Steps 1 to 5 are sub-issues of #303, steps 6
and 7 of #309; both issues are children of item 56's epic.

1. **The tracker interface removes a relation.** `unrelate(key, "blocks",
   target)` on the port, with a native removal on GitHub Issues, Linear and
   Jira, and a `tracker.ts unrelate` operation; tests per adapter. Nothing
   uses it yet.
2. **The planner moves in.** `plugin/skills/plan-epic/` with its
   instructions, scripts, schema document and tests, reshaped as the table
   above says: every read and write through the port, the format writer
   joined with the reader, dependency edges written as native relations
   first and mirrored into the block, plans parallel by default, the
   `plan_epic` settings, the lifecycle row, and the audit's view of the new
   skill. `/jig:do-item`'s instruction to run `sync-plan-blocks` on a
   dependency the tracker lacks keeps to plans without the planner's stamp;
   on a stamped plan the pickup runs the planner instead, so a relation a
   person removed is not written back. A dispatched planner pass stops on
   its approval rows as any dispatched pass stops on a decision. Tests run the end-to-end apply against an in-memory port, and on
   recorded answers of each adapter. Its pull request repeats the licence
   grant. After its release, the consumer switches to `/jig:plan-epic` and
   deletes its copy, and its instructions that call the planner switch with
   it (a consumer action the follow-up files); the copy takes no change in
   between.
3. **Filing hands its epic to the planner.** `/jig:file-issue`'s split ends
   by running the planner on the epic, with the filing's order, lanes and
   intent as the plan's inputs, written as the comments the planner reads.
4. **Relation statements.** The statement function beside the format
   module, the section rendered from it, and the statements in the
   planner's JSON output for a view to read.
5. **Footprints.** Each step's footprint, written where the design of #1179
   keeps it. It waits for that record.
6. **Keeping a plan current.** The mechanical edits for a changed epic,
   new children placed in parallel, the `is not in the plan` finding, and a
   dispatched pass's approval rows framed as one parked decision with the
   digest. It works beside #1144, the dispatcher's need for an epic its plan
   does not cover.
7. **The doctrine: acceptance, checked claims and the plan format.**
   [M6](../modules/M6-feature-delivery-pipeline/README.md) states an
   acceptance stage, a plan's claims about the existing system checked
   against the code before building, and the execution plan as an invariant:
   recomputed when the epic changes, mechanical edits applied, judgment
   edits approved, a blocker never less urgent than what it blocks, an epic
   filed only once its plan applies cleanly. With an acceptance-report
   template, the block's schema documented from the format module, a plan
   mode note in `review` for checking claims, and audit criteria scored in a
   re-audit of Jig.

## Left out

- **The other planning skills #303 once held**: prioritisation (#310), the
  epic acceptance review, a review-debt report, and a skill that applies
  approved learnings. They stay in the plan's "Tracker planning" entry,
  each its own issue.
- **Backfilling the open epics.** A later wave of #1177 runs the planner on
  them once step 2 has shipped. Backfilling makes each epic's relations
  true, and decomposes an epic with no children when its turn comes.
- **A planner stage the dispatcher starts by itself.** A stale plan raises a
  need (#1144). Starting a planner pass unasked waits until the line has run
  the planner on enough epics to show what its judgment needs.
- **Reading the order from the relations alone.** The block stays while its
  readers need it (ADR-0015).
- **The source's history.** The files move without the commits behind them;
  their history stays in the consumer repository, whose commit messages name
  that repository's own work.

## Review

Reviewed on 2026-11-14 by a reviewer with fresh context (a subagent that
did not write the design), at commit `a1699cad1` and again at `f52efefab`,
before any step is built.
