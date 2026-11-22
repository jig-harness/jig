# Tracker facets: type, priority and size

Version 1 · stable

Every issue carries facts beside its labels: what kind of work it is
(its type), how soon it matters (its priority) and how much work it is (its
size). Jig calls each an
[issue facet](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).
The [tracker interface](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(the one way Jig's skills read and write a tracker, whichever tracker it is)
holds each facet as a canonical value, the same on every tracker. Where the
tracker keeps the value is the facet's
[store](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): the
tracker's own field, a custom field, or a label per value. A repository
chooses it in `issue_tracker.facets`
([the configuration reference](../CONFIGURATION.md#issue_tracker)).

This chapter is for a program that reads an issue's facets as Jig reports
them, or that reads which store a repository keeps each facet in: a
dashboard, a script of a repository's own, another tracker adapter. Such a
program reads the canonical value and never parses the place it is kept.

These answers carry the facets:

- **An issue**, as `do-item`'s `get_issue.ts` prints it,
  holds `type` and `size`, each a value or `null` for none, and `priority`,
  a number from the table below.
- **`tracker.ts facet-stores`** prints, for each facet, its store and why
  that store is the one in force. A facet with a store also carries the
  values it keeps; one with none (`store` is `null`) carries no values and,
  where a cause applies, says why in `problem`. On GitHub Issues, a facet
  kept in labels also carries the store it could move to (`moveTo`): the
  tracker's own field or an issue field of the organization, or `null` for
  none; `moveTo` is absent where neither detection nor the organization's
  field discovery was read. It moves nothing.
- **The dispatcher's tick record** carries each facet's store and why, and
  the assigned items that lack a facet the repository keeps.

[Configuration](../CONFIGURATION.md#issue_tracker) explains how to set a
store, how Jig detects it, and what makes a read or write fail. The
[file-issue reference](../skills/file-issue/README.md) covers checking
facet values and moving them between stores.

## The facets

A type's and a size's values are the repository's own. The types are the
`types` list of its
[label taxonomy](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
or, with no taxonomy, its
[work types](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(`issue_tracker.types`). The sizes are the taxonomy's `size` group. A reader
takes a type or a size it does not know as a value of the repository's, not
as an error.

<!-- protocol:generated source=plugin/skills/do-item/scripts/lib/tracker/facets/facet-values.ts#FACET_TABLE -->

| Name | Meaning |
| --- | --- |
| `type` | What kind of work the issue is: a type of the repository's label taxonomy, or a work type where it has no taxonomy; null for none |
| `priority` | How soon the issue matters: a number from 1 (urgent) to 4 (low), or 0 for none |
| `size` | How much work the issue is: a label of the taxonomy's size group, null for none; a repository whose taxonomy has no size group has no size facet, and an epic is asked no size |

<!-- /protocol:generated -->

## Priorities

A priority is a number on the interface and a name in the configuration,
where a value map or a label list names each priority by its name. A reader
that meets a number this table does not list reads it as no priority.

<!-- protocol:generated source=plugin/skills/do-item/scripts/lib/tracker/facets/facet-values.ts#PRIORITIES,NO_PRIORITY -->

| Number | Configuration name | Meaning |
| --- | --- | --- |
| 0 | — | No priority: the issue is unranked, not low, so a pool that holds it cannot be worked in order; a filing through the tracker refuses it |
| 1 | `urgent` | The most pressing: before every other |
| 2 | `high` | Ahead of the usual run of work |
| 3 | `medium` | The usual run of work |
| 4 | `low` | Behind the usual run of work |

<!-- /protocol:generated -->

## Stores

`issue_tracker.facets.<facet>.store` names one of these, beside the keys
the store takes: `values` for a `native` or `field` store, `field` for a
`field` store, and `labels` or a `prefix` for a `label` store. A map may
list several names for one value, matched ignoring case: each is read as
that value and the first is written; only Linear's `native` priority takes
no list, since its numbers are Linear's own. No name may stand for two
values.

<!-- protocol:generated source=plugin/skills/do-item/scripts/lib/tracker/facets/facet-values.ts#FACET_STORES -->

| Name | Meaning |
| --- | --- |
| `native` | The tracker's own field for the fact: an issue type, a priority field or an estimate, each canonical value kept as the tracker's value of its own name unless the entry's values map names another; the exceptions are Linear's priority, kept as its number from 1 to 4, and Linear's size, kept as the team's estimate scale |
| `field` | A custom field the entry's field names, each canonical value kept as the option, text or number of its own name unless the entry's values map names another |
| `label` | A label per value: the value's own name (on GitHub Issues, a priority's is priority: followed by it), unless the entry's labels map names each value's label or its prefix comes before the value |

<!-- /protocol:generated -->

## The stores each adapter holds

Each tracker adapter holds some of the stores for each facet. A
configuration that names a store its adapter does not hold is refused when
it is read, with the reason this table gives.

A facet the configuration leaves out keeps its adapter's default: on Jira
and Linear, type and size in labels and priority in the tracker's own
priority field, except that on Jira a type or a size whose labels an
`issue_tracker.jira.field_labels` entry gives is kept in that entry's
field; on GitHub Issues, each facet where detection finds it, in labels
when a setting names its labels or any issue carries one. The full rules
are in [the configuration reference](../CONFIGURATION.md#issue_tracker).

<!-- protocol:generated source=plugin/skills/do-item/scripts/lib/tracker/facets/facet-values.ts#ADAPTER_FACET_STORES -->

| Adapter | Facet | `native` | `field` | `label` |
| --- | --- | --- | --- | --- |
| GitHub Issues (`github`) | `type` | The issue type | An issue field of the repository's organization, by name | A label per type |
| GitHub Issues (`github`) | `priority` | The organization's Priority issue field | An issue field of the repository's organization, by name | A label per priority, priority: urgent to priority: low unless issue_tracker.github.priority_labels or the entry's labels or prefix names them |
| GitHub Issues (`github`) | `size` | refused: an Effort issue field is a field store (store: field, field: Effort) | An issue field of the repository's organization, by name, such as Effort | A label per size |
| Jira (`jira`) | `type` | The issue type | A custom field of the site, by its name or its id | A label per type |
| Jira (`jira`) | `priority` | The priority field, each priority by the names issue_tracker.facets.priority.values or issue_tracker.jira.priorities gives it, else Highest, High, Medium and Low | refused: Jira keeps priority in its own priority field (store: native, with issue_tracker.jira.priorities) | A label per priority, named by labels or a prefix |
| Jira (`jira`) | `size` | refused: each site's estimate is a custom field: store: field, field: &lt;its name or id> | A custom field of the site, by its name or its id | A label per size |
| Linear (`linear`) | `type` | refused: Linear has no issue types | refused: the Linear adapter has no custom field to name | A label per type |
| Linear (`linear`) | `priority` | The priority field | refused: the Linear adapter has no custom field to name | A label per priority, named by labels or a prefix |
| Linear (`linear`) | `size` | The team's estimate | refused: the Linear adapter has no custom field to name | A label per size |

<!-- /protocol:generated -->

## Why a store is in force

`tracker.ts facet-stores` and the dispatcher's tick record give each facet's
store with one of these reasons. The store is `null` for `no facet` and
`conflict`, and on GitHub Issues for `default` too where detection could
choose no store. When detection fails as a whole, `facet-stores` answers
with what the configuration alone gives: a facet left to the default shows
the store and reason it has without detection, beside a detection whose
`status` is `failed`, and its reads and writes fail until detection
answers or the configuration names a store. A reader that meets a reason
this table does not list shows the store as reported and decides nothing
from the reason.

<!-- protocol:generated source=plugin/skills/do-item/scripts/lib/tracker/facets/facet-values.ts#FACET_STORE_REASONS -->

| Why | Meaning |
| --- | --- |
| `configured` | Named by issue_tracker.facets, or on Jira by an issue_tracker.jira.field_labels entry whose labels are the facet's values, which keeps the facet in that field |
| `kept in labels` | Kept in labels because a setting names the facet's labels (issue_tracker.types, issue_tracker.github.priority_labels) or, on GitHub Issues, an issue carries one |
| `detected` | Selected on GitHub Issues from what detection read: an issue's value in the tracker's own field, or, with no labels or values at all, the field the organization has |
| `default` | The adapter's default, with nothing named and nothing detected to move it. On GitHub Issues it is also the reason for a facet left to the default whose detection could choose no store (no answer, a failed read, a Priority field whose options do not name the priorities, values in the tracker's own field that cannot be read as the facet): store is then null, problem says why, and the facet's reads and writes fail until the configuration names a store |
| `conflict` | The facet's labels and values in the tracker's own field are both present and no store is named: store is null, and the facet's reads and writes fail, naming both stores, until the configuration names one |
| `no facet` | The repository has no such facet, as size with no size group, or its taxonomy cannot be read: store is null |

<!-- /protocol:generated -->

## Not in this chapter

A store kept by the repository's own command, which would answer with a
facet's value as JSON, is not built; until it is, this chapter has no
schema for it
([the design's later work](https://github.com/jig-harness/jig/blob/main/design/tracker-facets.md#later-the-command-store)).
How deep `do-item` goes for each work type is
[the work types' design](https://github.com/jig-harness/jig/blob/main/design/work-types.md).
