# Work types: design

**What problem this solves.** Every work item goes through the same stations
at the same depth. `do-item` routes only on whether an issue has sub-issues;
a one-line copy fix and a new feature both get the intent snapshot, the
three review tiers and a changelog note, and the only relief is a line count
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
`work-batch` and `file-issue`. Nothing of it is built.

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
2. The tracker's own issue type where the adapter exposes one (GitHub issue
   types; Linear has none, and the adapter says so).
3. The title's Conventional Commits prefix when the repository's title
   convention is conventional (`fix:` is a bug, `feat:` a feature, `chore:`
   and `docs:` a task, `refactor:` and `perf:` an improvement).
4. Otherwise `unknown`, which takes the strictest depth, and the run says so
   in its status line. In an interactive session `do-item` may ask one
   question; it never asks when a step above answered.

The evidence names which step decided. `file-issue` sets the type label at
filing time, so for an item Jig filed the first step always answers.

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
review never skipped, the change note required, not batchable, and the
union of the body sections. Autonomy stays `full`, because an unknown type
is not a spike; the `hitl` label still applies as on every type. An
override that lightens one type's row therefore cannot lighten `unknown`.

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
repository's items. The audit runs `determine_type.ts` on the items the
tracker shows changed in the last 30 days and reports the share typed by a
label (step 1) or the tracker's own type (step 2), with the evidence of a
sample. That is a fact about the repository, as the criteria must be, and
it is observed from the derivation's own output: a mapping no item's
labels reach does not pass it. That the mapping resolves to labels the
taxonomy declares stays a configuration check, reported beside it, not
the criterion.

## Configuration

| Field | Type | Default | Read by |
|---|---|---|---|
| `issue_tracker.types` | map from type to a list of labels | `bug` from `issue_tracker.labels.bug`, the rest `[<type>, type:<type>]` | do-item, work-batch, file-issue |
| `do_item.work_types.<type>.<field>` | one field of the depth table | the table above | do-item, work-batch |

## Build order

1. **The derivation.** `determine_type.ts`, `issue_tracker.types`, the
   defaults table as data with its tests, documented in
   [CONFIGURATION.md](../plugin/CONFIGURATION.md). `do-item` prints the type
   and changes nothing yet.
2. **`do-item` reads the row.** The scattered conditions move to the table;
   the tests for the pattern pre-scout and the review skip show the same
   behaviour from the defaults, then a `task` fixture shows the lighter path.
3. **`work-batch` and `file-issue`.**
4. **The map column and the audit criterion.**

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
