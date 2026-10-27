# Work types: design

**What problem this solves.** Every work item goes through the same stations
at the same depth. `do-item` routes only on whether an issue has sub-issues;
a one-line copy fix and a new feature both get the intent snapshot, the
review tiers and a changelog note, and the only relief is a line count
that skips the review. The kinds of work are already there, scattered:
`issue_tracker.labels.bug` turns the pattern pre-scout on (for a bug with no
pattern evidence yet, whose mistake could recur elsewhere),
`batch_sizes` decides what `work-batch` may take, `hitl` revokes autonomy,
and the [label taxonomy](../GLOSSARY.md) of
[M9](../modules/M9-tasks-memory/README.md) holds a closed list of types that
nothing downstream reads. With this built, an item's type is one derived
fact, one table says what each type changes, and depth shrinks for light
work without ever removing a gate a flag or the catalog demands.

This is the design of [plan.md](plan.md) item 27, a change to `do-item`,
`work-batch` and `file-issue`. The derivation (step 1 of the build order) is
built: `determine_type.ts` and the depth table as data in the
[`do-item` skill](../plugin/skills/do-item/SKILL.md#step-1-fetch-the-issue),
`issue_tracker.types` and `do_item.work_types` in the
[configuration reference](../plugin/CONFIGURATION.md#the-depth-table), and
the tracker interface's `nativeType`; `do-item` prints the type and changes
nothing else. Reading the row, `work-batch` and `file-issue`, the required
check, the map column and the audit criterion remain open.

## The rule

> An item's [work type](../GLOSSARY.md) is derived from the tracker, from a closed list the
> repository declares, and never asked when it can be derived. **One table**
> says what a type changes, with defaults a repository overrides. A type
> **lowers depth only where nothing else raises it**: a
> [flag label](../GLOSSARY.md), a mandatory review the
> [change-area catalog](../GLOSSARY.md) names, a gate in `do_item.gates` and
> the `hitl` label all keep their force whatever the type. An item whose type
> cannot be derived gets the deepest treatment, as a file no area matches gets
> the deepest validation profile in [M3](../modules/M3-change-area-catalog/README.md).

The depth is about how much the station does, never which stations exist:
the [lifecycle map](../GLOSSARY.md) stays one table, and a type is a column
of it, not a second map.

## How it works

### The types

The default list is `bug`, `feature`, `improvement`, `task` and `spike`.
`spike` is work whose deliverable is a finding or a decision, the kind
`do-item` already treats as human-in-the-loop
([HITL](../GLOSSARY.md)); naming it a type lets the derivation set `hitl`
behaviour without a label. A repository renames or drops types through the
mapping below; it does not add stations.

### Derivation

`plugin/skills/do-item/scripts/determine_type.ts` reads the issue JSON
`get_issue.ts` returns and prints `{type, evidence, depth}`, trying in order:

1. A label in the taxonomy's `types` family, through
   `issue_tracker.types` (`{bug: [bug, type:bug], feature: [feature, type:feature], …}`),
   which generalises `issue_tracker.labels.bug` and keeps it as an alias.
2. The tracker's own issue type, from the issue's `nativeType` field
   (GitHub issue types; Linear has none, and its adapter sets the field to
   `null`, which leaves this step unanswered). A value is matched to a
   type name in the effective type set ignoring case, so `Bug` gives
   `bug`; a value that matches none, such as a custom `Incident`, leaves
   this step unanswered, and the evidence names the value.
3. The title's Conventional Commits prefix when the repository's title
   convention is conventional (`fix:` is a bug, `feat:` a feature, `chore:`
   and `docs:` a task, `refactor:` and `perf:` an improvement). A prefix
   answers only when its type is in the effective type set: a prefix whose
   type the repository dropped or renamed leaves this step unanswered, as
   an unmatched `nativeType` does in step 2, and the evidence names the
   prefix.
4. Otherwise `unknown`, which takes the strictest depth, and the run says so
   in its status line. In an interactive session `do-item` may ask one
   question; it never asks when a step above answered.

The evidence names which step decided, and each earlier step that saw a
value but did not answer. Labels of two types on one item are a choice
someone must make, not one a weaker signal settles: the item is `unknown`.
`file-issue` sets the type label at filing time, so for an item Jig filed
the first step always answers.

### The depth table

`do_item.work_types` holds one entry per type; absent entries take these
defaults, and a repository overrides a single field rather than the row.

| Field | `bug` | `feature` | `improvement` | `task` | `spike` |
|---|---|---|---|---|---|
| `pre_scouts` | `pattern` (the pattern pre-scout) | `spec` (the item links or carries its requirements; see [the spec a work item links](spec-link.md)) | `spec` | none | none |
| `test_first` | required: a failing test before the fix, recorded as [M14](../modules/M14-testing-strategy/README.md)'s seen-to-fail | required for new behaviour | as the change needs | none | none |
| `review_tiers` | 1, 3 | 1, 2, 3 | 1, 2, 3 | 1 | none |
| `review_skip_lines` | 20 | never | 20 | 50 | none |
| `change_note` | required where the changelog skill is on | required | required | not required | not required |
| `batchable` | yes, within `batch_sizes` | no | within `batch_sizes` | yes | no |
| `autonomy` | full | full | full | full | `hitl` |
| `pr_body_sections` | reproduction, cause, fix | requirements covered, what was left out | before and after | what changed | findings, recommendation |

No single row is the deepest in every field (a bug has the pattern
pre-scout a feature lacks), so `unknown` is not a row a repository edits or
points at another type. It is computed field by field from the effective
rows, the defaults with the repository's overrides: the union of the
pre-scouts, `test_first` required, the union of the review tiers, the
review never skipped, the change note required, not batchable, the
union of the body sections, and autonomy `hitl`: failing to derive a type
does not show the item is not a spike. An unattended run therefore stops
on an `unknown` item and states the gap, as it does on a `hitl` label, and
a type label clears it. An override that lightens one type's row cannot
lighten `unknown`: its lists also take in each default type's default row.

These columns never appear: which agent implements (that is routing by label
and catalog area, which stays as it is) and which catalog review skills run
(the catalog's `reviewSkills` and `do_item.gates` run on every type; the
table cannot name them because it cannot remove them).

### Where it is read

- **`do-item`** runs `determine_type.ts` after it fetches the issue and
  reads the row instead of the scattered conditions: the pattern pre-scout,
  the review tiers and the skip threshold, the changelog note, the body
  sections, the `hitl` default for a spike. The status line names the type
  and its evidence.
- **`work-batch`** takes `batchable` from the row instead of its own size
  rule alone, so a feature never enters a batch however small its label.
- **`file-issue`** asks for the type when the description does not make it
  clear, from the taxonomy's `types` family, and writes the label.
- **The lifecycle map** gains an optional column per stage, *types that
  pass through it lightly*, with the depth the row gives; the map gate
  checks the column names declared types only.

### The audit

M9's criteria gain one at Standard: the pickup procedure types the
repository's items before it works them. Its rungs follow the
[criteria ladder](../plugin/skills/audit/criteria/README.md). The
`convention` observation is the policy: the taxonomy declares the `types`
family and the instructions say how every item gets its type: a type
label, or the title prefix where the repository's title convention
declares one (step 3). The
pickup procedure that derives the type and treats an underivable one as
`unknown` (`do-item` with this design built), and the filing procedure that
writes the type label (`file-issue`), run only where those helpers are
used: an item picked up by hand or filed directly passes neither, so on
their own they score `advisory`. The `mechanical` observation is
enforcement on every change: a required check on the pull request derives
its linked item's type the same way and refuses one whose item's type
derives as `unknown`, or that links no item at all, so no work reaches a
merge without a type; `do-item`'s strictest depth for `unknown` governs
the work until then, and a type label clears both. It counts as enforcement only when nothing it decides with
comes from the pull request it judges
([M7](../modules/M7-pr-lifecycle-review/README.md), invariant 8): its
workflow and script and `issue_tracker.types` are read from the target
base branch or a pinned version, never from the head, so a pull request
that changes the mapping is judged by the base's mapping, and the change
takes effect once it merges. The head's copy may run only in a separate,
unprivileged shadow job with no secrets and a read-only token, never in
the job that decides, and reports what it would decide as a comment that
decides nothing (M7, invariants 8 and 9). Beside the
score, as evidence and not as a rung, the audit runs `determine_type.ts` on the items the tracker
shows changed in the last 30 days and reports the share each step typed
(label, tracker type, title prefix) and the share left `unknown`, with a
sample of the `unknown` items and their labels, so a type whose mapping
matches none of the labels items actually carry is visible. That the mapping resolves to labels the
taxonomy declares stays a configuration check, reported beside it.

## Configuration

| Field | Type | Default | Read by |
|---|---|---|---|
| `issue_tracker.types` | map from type to a list of labels | `bug` from `issue_tracker.labels.bug`, the rest `[<type>, type:<type>]` | `determine_type.ts`, the required check, do-item, work-batch, file-issue |
| `do_item.work_types.<type>.<field>` | one field of the depth table | the table above | do-item, work-batch |

The effective type set is the keys of `issue_tracker.types`, or the
default list when the field is unset. Renaming a type is a new key whose
row is copied from nothing: a type outside the default list must carry a
complete `do_item.work_types` row, a default type left out of the map is
dropped with its row, and `unknown` is never a key. Loading the
configuration refuses a type with no complete row, a `do_item.work_types`
entry for a type outside the set, and a label listed under two types,
since the derivation's first step could not then decide.

## Build order

1. **The derivation.** `determine_type.ts`, `issue_tracker.types`, the
   defaults table as data with its tests, documented in
   [CONFIGURATION.md](../plugin/CONFIGURATION.md). The tracker interface's
   `Issue` gains a provider-neutral `nativeType` field, the tracker's own
   type name or `null`, and `get_issue.ts` prints it: the GitHub adapter
   fills it from the issue type, and the Linear adapter always sets `null`,
   which is how it says it has none. Derivation step 2 reads only that
   field. `do-item` prints the type and changes nothing yet.
2. **`do-item` reads the row.** The scattered conditions move to the table;
   the tests for the pattern pre-scout and the review skip show the same
   behaviour from the defaults, then a `task` fixture shows the lighter path.
3. **`work-batch` and `file-issue`.**
4. **The required check**: a portable script that derives the linked
   item's type as `determine_type.ts` does and refuses a pull request
   whose item's type is `unknown` or that links no item; its tests; a workflow
   template that runs the script and reads the mapping from the base
   branch, never the head, and the setup step that makes it a required
   check on the base branch. Until a
   repository installs it, the criterion scores `advisory` there.
5. **The map column and the audit criterion.**

## Left out

- **Numbered pipeline stages per type.** Stages stay named and shared; a
  type changes depth inside them.
- **A spec format per type.** What a feature's `spec` pre-scout accepts is
  the subject of [the spec a work item links](spec-link.md), not of this
  design.
- **A type that changes the agent.** Routing by label and area already does
  that, and two routes for one choice would disagree.
- **Depth inside the drive.** `drive-pr`'s rounds answer reviewers, whose
  depth is theirs; a type that shortened the drive would be a type that
  ignores a reviewer.
