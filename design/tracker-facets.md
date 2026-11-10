# Issue facets: type, priority and size wherever the tracker keeps them: design

**What problem this solves.** A team sorts and filters its issues by what
kind of work each one is (its type), how soon it matters (its priority) and
how much work it is (its size). Jig's skills read the same facts: `do-item`
sets how deep each station goes from the type, and `work-batch` ranks by
priority, sends an urgent issue alone and batches only small sizes. Yet one
repository keeps each of these facts in several ways at once, depending on
the tracker and on who filed the issue: in the tracker's own field, in a
label, or nowhere. The triage of Jig's 158 open issues on 2026-11-06
counted it: none used the organization's Priority or Effort field, 66 had
no priority, 41 no size, 9 no type, and 32 had a type only as a label; 8
carried no label at all, filed by hand with `gh issue create`. A tracker
whose types are half in labels and half in its own field cannot be filtered
by type, and an issue filed without a priority is not low priority but
unranked ([M9](../modules/M9-tasks-memory/README.md#priority-and-category-at-birth)),
so a pool that holds it cannot be worked in order. The causes lie in the
interface, not in one skill:

- **The [tracker interface](../GLOSSARY.md) has no type or size.** A new
  issue carries a title, a description, labels, a priority, a parent and a
  project. Type and size travel as labels, and the tracker's own issue type
  is read (`Issue.nativeType`) but never written.
- **Each adapter fixes in code where a fact is kept.** Priority is a label
  on GitHub Issues and a field on Linear and Jira. Type is a label
  everywhere but Jira, where every new issue gets the one issue type
  `issue_tracker.jira.issue_type` names, a bug and a feature alike.
- **Only `file-issue` checks that an issue is complete.**
  `Tracker.createIssue` checks shape (a label, a parent or a project that
  resolves to nothing), never a missing type, priority or size.
  [`file-deferred.ts`](../plugin/skills/resolve-review-comments/scripts/file-deferred.ts)
  files a deferred review finding with the follow-up label alone;
  [`report-bug.ts`](../plugin/skills/jig/scripts/report-bug.ts) and the
  [issue forms](../.github/ISSUE_TEMPLATE/bug.yml) set a label and nothing
  else; an agent that runs `gh issue create` by hand sets what it
  remembers.

With this built, type, priority and size are each an
[issue facet](../GLOSSARY.md) (a facet, in this design): a value the
interface carries on every issue it reads and writes, the same in every
repository. Where the tracker keeps it is the facet's
[store](../GLOSSARY.md), set per facet in the repository's configuration,
with a documented default per adapter. Callers read the value, never the
label or field behind it. Every path that files through the interface
writes each facet, and one check run inside the write refuses an issue that
lacks one. A filing that goes around the interface (an issue form, a bug
report, `gh issue create` by hand) is caught afterwards: the pools report an
issue that lacks a facet on every read, and a weekly sweep catches the
rest.

Fixing the filing paths alone, on today's stores, would close the gaps the
count shows on Jig. The stores are configurable as well because the facts
belong where the team already filters: each of type, priority and size can
be a tracker's own field, a custom field or labels, per repository. A Jira
site's custom issue types and custom fields need that flexibility, a Linear
team that keeps labels has made a legitimate choice, and on GitHub the
organization's fields are the default for a repository that does not keep
the facet in labels already.

Its plan item is item 41 in [plan.md](plan.md). It changes `do-item`'s
tracker interface ([`port.ts`](../plugin/skills/do-item/scripts/lib/tracker/port.ts))
and its adapters, and the callers that read type, priority and size: the
[work-type](work-types.md) derivation, `work-batch`, the
[dispatcher](../GLOSSARY.md)'s pools and `file-issue`.

## The rule

> Every work item carries a type, a priority and a size beside its labels.
> The tracker interface holds each as a **canonical value**; where the
> tracker keeps it is configuration, per facet, with a documented default
> per adapter. Callers read the value and never parse the place it is kept.
> **No repository's store of record moves** unless its configuration says
> so or a person runs the move. Every path that files an issue through the
> interface writes each facet, and **one check, run inside the write**,
> refuses an issue that lacks one; a filing around the interface is caught
> by the pools and the sweep.

This is M9's rule of
[priority and category at birth](../modules/M9-tasks-memory/README.md#priority-and-category-at-birth),
widened from the priority to the type and the size, and moved from one
skill into the write itself.

## How it works

### The facets and their values

| Facet | Canonical value | Where the values come from |
| --- | --- | --- |
| `type` | a type name, or `null` for none | the closed `types` list of the repository's [label taxonomy](../GLOSSARY.md), which `issue_tracker.types` maps to [work types](../GLOSSARY.md); with no taxonomy, the work types themselves |
| `priority` | `1` (urgent), `2` (high), `3` (medium), `4` (low), or `0` for none | fixed; the configuration names them `urgent`, `high`, `medium` and `low` |
| `size` | a size name, or `null` for none | the taxonomy's `size` group (Jig's: `xs`, `small`, `medium`, `large`, `xl`); with no size group, there is no size facet |

Priority keeps the numbers the interface already uses (`PoolIssue.priority`,
`NewIssue.priority`). A type or a size is the id the taxonomy declares,
whatever the tracker shows: on Jig's repository after its move the type
`docs` is the issue type Docs, and in a repository that keeps types in
labels it is the label `docs`.

A type and a work type stay two things. The type is what the tracker
records (Jig's taxonomy has `bug`, `feature`, `docs`, `chore` and `infra`).
The work type is how deep `do-item` goes, derived from the type through
`issue_tracker.types` (Jig maps `docs`, `chore` and `infra` to the `task`
work type). This design makes the type a value of the interface; the
derivation and its depth table stay as [work types](work-types.md)
describes them, its first step reading the type facet instead of labels.
`Issue.nativeType` stays, read-only, as the tracker's own type name: the
derivation's evidence line and the weekly sweep name it when it maps to no
type, and no caller decides with it, except that the adapter reads it once,
with `epic_types`, to set `isEpic`; the filing check and the census read
`isEpic`, never the native type.

### Stores

A store is where a tracker keeps one facet:

- `native`: the tracker's own field for that fact;
- `field`: a custom field the repository names;
- `label`: a label per value, named one by one or by a prefix.

What each tracker can hold:

| Store | GitHub Issues | Jira | Linear |
| --- | --- | --- | --- |
| `native` type | the issue type | the issue type | refused: Linear has no issue types |
| `native` priority | the organization's Priority issue field | the priority field | the priority field |
| `native` size | refused: an Effort issue field is a `field` | refused: each site's estimate is a custom field | the estimate |
| `field` | an issue field of the repository's organization | a custom field, by name or id | refused: the adapter has no custom field to name on Linear |
| `label` | any facet | any facet | any facet |

A store the adapter cannot hold is refused when the configuration is read,
naming the facet and the stores that adapter has. A store kept by the
repository's own command is [later work](#later-the-command-store).

### Value maps

A `native` or `field` store keeps values in the tracker's own vocabulary,
so it maps each canonical value to tracker values: an issue type's name,
a field option's name, or a number. A `label` store maps each value to
labels. A map may list several names for one canonical value, matched
ignoring case: every listed name is read as that value and the first is
written. No name may stand for two canonical values, so a value read back
names exactly one, and a map that gives two canonical values one tracker
value is refused when the configuration is read.

A canonical value the map leaves out takes the tracker value of its own
name, matched ignoring case (`bug` is the issue type Bug, `small` the option
small). A tracker value that names no canonical value, such as an issue
type Incident nobody mapped, reads as none, and the weekly sweep reports
the issue. A map value that names nothing on the tracker (an issue type the
organization does not have) is refused at the first write that needs it,
before anything is written, naming the value and what the tracker has: the
way a label that resolves to nothing is refused today.

Today's keys list several labels for one value
(`issue_tracker.types.bug: [bug, type:bug]`). The first label listed is the
one written; the others are read as the same value. No label may name two
values, which loading already refuses.

### Defaults per adapter

A facet whose store the configuration does not name gets its adapter's
default:

| Facet | GitHub Issues | Jira | Linear |
| --- | --- | --- | --- |
| Type | for a repository that keeps no type labels, the issue type, matched by name, a type with no issue type of its name refused when it is filed; type labels otherwise | type labels, and every new issue filed as the one `issue_tracker.jira.issue_type`, as today | labels from `issue_tracker.types`; Linear has no issue types |
| Priority | for a repository that keeps no priority labels, the organization's Priority field; `priority:` labels otherwise | the priority field | the priority field |
| Size | for a repository that keeps no size labels, the organization's Effort field, when its options carry the size names; size labels otherwise | size labels, as today, until a field is named, since each site's estimate field differs | size labels; the estimate as an option |

**No store moves by itself.** A GitHub repository keeps a facet in labels
when a key of today names that facet's labels (`priority_labels`, or the
labels `issue_tracker.types` lists) or when any of its issues, open or
closed, carries one of that facet's labels; a label merely defined, such as
the `bug` label GitHub gives every new repository, does not count. Such a
repository files and reads exactly as it does today after every upgrade,
unless the facet also has native evidence (below), which is a conflict;
the organization field it could move to is reported by `facetStores()` and
by the audit, and it moves by running
[the move](#moving-a-repository-from-one-store-to-another) and then naming
the new store in its configuration. An explicit `store` always wins. The
field default reaches only a repository with no labels for the facet and
no store named, such as a new one.

**A store the default selected stays selected, from shared state alone.**
Detection reads only the tracker, so every clone reaches the same answer and
no clone holds a memory the others lack. A facet's value written to the
native store (an issue type, a field value) is evidence for the native store;
a label of the facet is evidence for the labels store, whatever wrote it. Native evidence
and label evidence together are not resolved by guessing: the facet is in
conflict, and reads and writes of it fail closed in every clone, with an
error naming both stores, until the configuration names one; `facetStores()`
shows the conflict. No pairing is excused, because no label shows who wrote
it: a repository that began on the native store and later gains a label of
the facet is in conflict too, from either side. A facet with no evidence at
all reads as the default its adapter gives; deleting a field whose values
were the only evidence is therefore not detected until the configuration
names the store, which the audit asks every repository relying on a default
to do. The audit
reports a repository whose facet has no named store, so a repository relying
on a default has it committed rather than inferred.

This rule is load-bearing. GitHub's issue fields have been
[generally available since 2026-07-02](https://github.blog/changelog/2026-07-02-issue-fields-are-now-generally-available/)
on the Free, Team and Enterprise plans, and ship in GitHub Enterprise
Server 3.23. Every organization gets Priority (Urgent, High, Medium, Low),
Effort (High, Medium, Low), Start date and Target date by default, so
detection finds a Priority field in every GitHub organization. Without the
rule, every repository that keeps priority in labels would move its
priority to that field on its first upgrade, whoever added the field and
whatever the repository's own searches and boards read.

**On GitHub the fields are detected, never switched on.** For a facet the
rules above leave open, the adapter reads the organization's issue types
and issue fields. A Priority field counts when its options name the
priorities (Urgent, High, Medium and Low, ignoring case), as the default
field's do; one whose options an organization renamed is an error naming
the two ways out (a `values` map, or `store: label`), not a quiet fall back
to labels. An Effort field counts when its options are the taxonomy's
sizes; the default Effort's High, Medium and Low are not, so size stays in
labels unless the organization sets its Effort options to the size names
or a `values` map names them. A repository a person owns has no issue
fields, so it uses labels. A type with no issue type
of its name, such as `docs` in an organization that has only Bug, Feature
and Task, is refused when it is filed, naming the two ways out: a `values`
map, or `store: label`. A label of the facet beside a defaulted native
store is the conflict above, not a label store. An organization's issue
types are shared by every repository in it, so a repository's extra types
are not added to them.
A repository on a detected field is told by `facetStores()` and the audit
to name that store in its configuration: until it does, an organization
admin who renames the Priority field's options or moves the Effort options
away from the size names makes that facet's filings and reads fail with an
error that names the two stores, which the dispatcher's tick record shows;
nothing moves to labels by itself. Deleting the field is different: it
removes the evidence, so an unnamed facet reads as its default again (the
limit stated above), and only a named `store` makes the deletion fail
every read and filing.

**On Jira every issue has an issue type.** Type moves to issue types only
when `issue_tracker.facets.type` names the `native` store, with a `values`
map where names differ (`feature: Story` is an example map, never a
default). Then a type with no issue type of its name is filed as
`issue_tracker.jira.issue_type` and keeps its value in its label, and an
issue created under a standard issue is a sub-task, as today, and keeps its
type in its label too. Such an issue can name two values when
`issue_type` is itself a mapped value (`task` → Task), and a GitHub type
kept as a label can sit beside an issue type someone set by hand. A type
label wins over Jira's fallback issue type (`issue_type` or the sub-task
type); any other two different values read as no type, as two type labels
make an item `unknown` in [work types](work-types.md), and the weekly sweep
reports the issue. On Jira the issue type chooses the workflow and the
create screen per project, so every issue type a map names must reach the
states `issue_tracker.states` names; the live run in build step 4 moves one
issue of each mapped type through them.

### Who can set a facet

| Store | Who can write it |
| --- | --- |
| GitHub issue type, issue fields, labels | anyone with triage access to the repository; an issue form sets the type it names for any filer, as it sets its label today |
| Jira issue type, priority, custom fields, labels | anyone with Edit Issues in the project |
| Linear priority, estimate, labels | any member of the team |

No store lets anyone set a type who cannot set its label today. The type
lowers depth only where nothing else raises it ([work types](work-types.md)):
flag labels, the reviews the change-area catalog names and the gates keep
their force whatever the type. The dispatcher starts work only on an
assignment a trusted person made, and its receipt records each facet's
value and the store it came from, so a type changed after the assignment is
visible beside the work it shaped. Each tracker keeps the history of who
changed a field, a type or a label.

### Configuration

One section, `issue_tracker.facets`, holds an entry per facet; an entry
left out takes its adapter's default. For example, a Jira repository that
keeps type in its issue types, priority in labels of its own, and size in a
number field:

```yaml
issue_tracker:
  facets:
    type:     { store: native, values: { bug: Bug, feature: Story, task: Task, spike: Spike } }
    priority: { store: label, labels: { urgent: P0, high: P1, medium: P2, low: P3 } }
    size:     { store: field, field: customfield_10016, values: { xs: 1, small: 2, medium: 3, large: 5, xl: 8 } }
```

A value may list several names, the first written and all read:
`values: { bug: [Bug, Defect], feature: Story }`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `issue_tracker.facets.<facet>.store` | `native`, `field` or `label` | the adapter's default above | Where the facet is kept |
| `….values` | map from a canonical value to a tracker value, or to a list of them | each value by its own name | `native` and `field`: the issue type, option or number that holds each value; a list is read in any of its names and written as its first |
| `….field` | a field's name or id | none; required by `field` | `field`: the custom field, a GitHub issue field by name, a Jira field by name or id (`customfield_10016`) |
| `….labels` | map from a canonical value to a label, or to a list of labels | the value's own name; on GitHub, priority's `priority: <name>` | `label`: the label of each value; a list is read in any of its labels and written as its first |
| `….prefix` | a label prefix | none | `label`: each value's label is the prefix followed by the value (`size:small`); refused beside `labels` |
| `issue_tracker.facets.sweep` | `move` or `comment` | `move` | The weekly sweep's action on an incomplete issue: comment and move it to triage, or comment only (`check-fields.ts --comment-only` sets it for one run) |
| `issue_tracker.labels.epic_types` | list of issue type names | none | An issue of one of these native types reads as an epic on every adapter with issue types, beside the epic label; it is exempt from the size requirement everywhere the epic label is |

Outside GitHub, a priority kept in labels needs `labels` or a `prefix`,
since a Jira label holds no whitespace and so cannot take GitHub's default.
A Jira field named by a name that several fields of the site share is
refused, naming each one's id, as `field_labels` refuses it today; the id
is the form to write.

Refused when the configuration is read: a facet other than `type`,
`priority` and `size`; a store the adapter cannot hold; a key outside the
facet's values (`critical` for priority); a map that gives two values one
tracker value; `labels` beside `prefix`; a label that is also a state's
label (`issue_tracker.states`, in labels mode) or another facet's label,
since one label would then set two facts; and a facet set here and through
one of today's keys below with different labels.

### What today's keys become

| Key today | Becomes |
| --- | --- |
| `issue_tracker.types` | It keeps mapping work types to type values, and, set, it keeps the type facet in labels on GitHub until `store` names another: `task: [docs, chore, infra]` lists type values, each the label of its own name, all of them `task` work |
| `issue_tracker.labels.bug` | The labels of the `bug` type in a label store, as it is today an alias of `issue_tracker.types.bug` |
| `issue_tracker.github.priority_labels` | The priority facet's `labels`; set, it keeps priority in labels until `store` names another |
| `issue_tracker.jira.field_labels` | An entry whose values are a facet's values (a `Size` field whose labels are the size group's) is that facet's `field` store, now written as well as read, and its values still show as labels; any other entry reads as labels, as it does today |
| `issue_tracker.jira.priorities` | The priority facet's `values` map on Jira, seeded from it: its entries and its defaults (urgent is Highest) stay the names written and read until `issue_tracker.facets.priority.values` is set; a facet map that gives a canonical value another name than this key does is refused when the configuration is read |
| `issue_tracker.jira.issue_type` | The issue type of every new issue until a type store is named, and then of one whose type has no issue type of its own name, and of one created under an Epic |
| `issue_tracker.labels.batch_sizes`, `work_batch.sizes` and `size_points`, `routing.raise.sizes`, `review.taxonomy.sizes` | Each entry is read as a size value, or as the label of one, so a list keeps working whatever store the size is in |

A repository that set any of these keeps working with no change to its
file.

### The interface

`port.ts` changes:

- `Issue` gains `type: string | null`, `priority: number` and
  `size: string | null`. `PoolIssue` gains `type` and `size` beside the
  `priority` it has, and `isEpic: boolean`, set by the one recognition
  below (the epic label, or a native type in `epic_types`), since the
  canonical type cannot recover a native type that a label store or a
  collapsing value map hides. `Issue` carries `isEpic` too. `LedgerIssue` keeps only `priority`, the one facet the
  ledgers read.
- `NewIssue` gains `type?` and `size?` beside `priority?`. `IssuePatch`
  gains `type?` and `size?`, where `null` removes the value.
- `PoolQuery` gains `facets`, with `oneOf` (type or size values: an issue
  matches when its value is in the list) and `missing` (facets: an issue
  matches when it has no value for one of them). `work-batch` selects its pool by size this way, and reads
  its labelling gaps with `missing`, instead of by size labels.
- `Tracker` gains `incompleteIssues({ missing, retired, after?, limit })`:
  one page of open issues not in the triage state and not yet started that
  lack a value for a listed facet (`missing`) or carry a label a facet's
  store has retired (`retired`), a cursor for the next, and, with every
  page, the tracker's own counts of the open issues outside triage that
  must carry each facet and of those among them lacking it (an epic is not
  counted for size, as in [the write's check](#checked-inside-the-write)),
  so a ratio never has a filtered denominator or counts a lawful absence. A
  started issue is never in these pages, so one that stays incomplete cannot
  use up the read; the sweep lists them from a separate read of one page of
  100. It is the weekly sweep's read, and the one read of the interface that
  returns part of a population on purpose, so it says so in its name and its
  cursor. Its pages are ordered oldest first, an order no write changes, so
  the cursor of one run can be kept and resumed by the next, which is how the
  sweep's comment-only mode reaches issues past a capped read
  ([the weekly sweep](#the-weekly-sweep)).
- `Tracker` gains `facetStores()`: each facet's effective store and why
  (configured, kept in labels, detected), and on GitHub what detection saw
  (the field, its options, the credential that read them), so the check, the
  audit and a person can see where a value is kept without reading the
  adapter. It reports two things apart: the **store health** of each
  configured store, which uses only the access the store's own reads and
  writes use, and **organization discovery**, the optional read of the
  organization's issue types and fields. A denied discovery read is reported
  as discovery unavailable and fails nothing; a configured store that
  cannot be read or written is a store that fails closed.

An adapter filters by a facet in the tracker's own query where it can: a
label store on every adapter, Jira's issue type, priority and custom fields
in JQL (`is EMPTY` for `missing`), Linear's priority and estimate in its
filter. Otherwise it filters the issues its query returned: on GitHub a
size kept in an issue field is filtered from the pool the area labels
select, so the local filter's cost grows with that area's open issues, not
with every open issue. Either way a pool is read whole or not at all.

### Reading and writing a facet

The code shared by every adapter lives in a new `lib/tracker/facets/`
folder: `config.ts` (the section, the defaults and today's keys),
`values.ts` (the value maps and their reverse), `label.ts` (the label
store), `detect.ts` (the GitHub default's rules and their cache) and
`complete.ts` (the filing check). Each adapter keeps its `native` and
`field` stores beside its own code: `github/facets.ts`, `jira/facets.ts`,
and `linear-facets.ts` beside `linear.ts`, which is already past the
[file-size limit](../docs/adr/ADR-0007-source-file-size-ratchet.md).

A write takes the canonical value and writes it to its store, in the create
request itself where the tracker allows: GitHub's `createIssue` takes the
issue type (`issueTypeId`) and the issue field values (`issueFields`), and
Jira's create takes the issue type and custom fields. A change replaces the
old value in one request where the tracker takes it: GitHub's `updateIssue`
takes the issue type, the issue field updates (`issueFieldUpdates`) and the
label set together, and in a label store the old label comes off as the new
one goes on, as the GitHub adapter's priority labels do today. From build
step 2, when the callers read the facets, a label a label store owns is the
facet's to write: naming one in `NewIssue.labels` or `IssuePatch.addLabels`
is refused, pointing at the facet, as the GitHub adapter refuses a priority
label today.

**What a GitHub read costs.** Every pool and single-issue read adds the
issue type's name and the issue's field values to the fields it already
requests, so no list read makes an extra request per issue. The field
values are read 25 to a page; an issue with more than one page of values is
read again alone with every page, so the pool still reads whole rather than
failing. Ledger and labelled-issue reads ask only for priority. Build step 1
measures the GraphQL cost (`rateLimit { cost }`) and the latency of the
pool, ledger and assigned-issue queries before and after, on Jig's
repository and on a fixture of 1,000 issues, with the facets in labels and
in fields.

**Detection is cached, and runs for every facet the configuration does not
name.** Label rules never settle a store alone: detection reads label
evidence and native evidence together, so a repository whose labels settle
the store is still in conflict when native evidence for the facet exists.
It runs before the reads and writes that touch that facet, not before every
call. What it reads (whether the repository's issues carry the facet's
labels, the organization's issue types and fields) is cached for one hour
in the clone's [machine-local store](../GLOSSARY.md), keyed by repository,
organization and a non-secret fingerprint of the credential that read it (a
salted hash of the token, never its login, which two tokens of different
reach share), and dropped when
a write is refused for a value the cache named. For a facet whose
configuration names its store, only the discovery part of `facetStores()`
and the audit read the organization, to report the field it could move to;
its reads, its writes and its store health never wait on detection or on
discovery. Detection needs a credential that can read the
organization's issue types and fields, which a repository-scoped token or a
workflow's `GITHUB_TOKEN` may not; a repository that files and reads with
such a credential names every facet's store, so its reads and writes need no
organization access.

### Failures, and what they show

Every store fails closed. A detection read that is denied (a workflow token
or a fine-grained token without organization access), rate limited, timed
out or unanswered is an error naming the read and the credential, never
"the organization has no field"; it is reported as the transport reports
any failed read, unavailable with GitHub's `Retry-After`, and not retried
behind the caller's back. A field value that cannot be read fails the read
it belongs to, and a value that names nothing fails the write before
anything is written.

A failure's text is one line of at most 300 characters: the store, the
facet, the issue key and the tracker's status and error code, never a
response body, a header or a credential. It reaches the caller's exit and
message, and the dispatcher's tick record; no store writes it into an issue
or pull request comment.

The dispatcher's tick records, in its tracker record (its receipt), each
facet's store and why, whether detection answered from its cache, and the
pool read's request count and duration, so a store that fails or changes is
seen on the next tick, not at the next sweep.

### Checked inside the write

One function, `facets/complete.ts`, checks a new issue: a type, a priority
(`1` to `4`) and a size, for each facet that has a store, with no size
required on an epic: an issue carrying the epic label (`issue_tracker.labels.epic`) or, on an
adapter with issue types, one of a native type listed in `issue_tracker.labels.epic_types`. That one
recognition also governs filing completeness, the sweep's eligibility and the
incomplete-issue census's denominators, so a native-only epic is never sent
back to triage for a missing size;
and a label of every required group of the taxonomy, the size group's
requirement being met by the size facet in whatever store it is kept. It
reads the taxonomy through `file-issue`'s taxonomy reader and reuses its
label check (`validate.ts`).

It runs inside the tracker `openTracker()` returns: `lib/tracker/index.ts`
wraps every adapter's `createIssue` in it, so every caller of
`Tracker.createIssue` gets it, `tracker.ts create` and `file-deferred.ts`
today and any later one alike. Records are not filed through
`createIssue`: `reflect`'s GitHub store writes its own request, and a
record store that moves onto the interface gets an operation of its own,
so `createIssue` offers no way around the check.

| Path | Today | With this built |
| --- | --- | --- |
| `file-issue` | writes through `tracker.ts create`; type and size as labels, priority optional | the same command, checked inside the write; priority required |
| `tracker.ts create` (`do-item`) | checks shape | checked inside the write, the missing facet named |
| `file-deferred.ts` | the follow-up label only | checked inside the write; the type from the finding, the priority from the [severity mapping](../GLOSSARY.md) M9 names, the size `small` unless the entry names one |
| `report-bug.ts` | `gh issue create` with the `bug` label | sets the Bug issue type where the account may set types; priority and size from triage |
| The issue forms | a label | `type: Bug` on the bug form, `type: Feature` on the change form; priority and size from triage |
| An agent by hand | whatever it sets | reported by the pools on their next read, and moved by the weekly sweep |

`file-deferred.ts` takes the type from the finding as the
[deferral protocol](../plugin/skills/resolve-review-comments/references/deferral-protocol.md#labels)
says (a deferred correctness finding is a `bug` whatever the pull request
was), so the entry `defer-in-pr.ts` writes into the pull request records the
type, the severity and the category `defer-batch.ts` already takes. A
finding of `unknown` severity files as medium, set once in the shared
severity mapping (`SEVERITY_TO_PRIORITY` in `defer-batch.ts`) and in the
append rules beside it, so every path that files or updates a finding gives
it the same priority. An entry written before
`defer-in-pr.ts` records type and severity stays in the pull request's
section, reported as one a person files through `/jig:file-issue`.

The issue forms set the type (`type:` in the form) but not the priority or
the size, since
[field values cannot be pre-filled from an issue template or a URL](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-and-managing-issue-fields).
They come from triage: the pools report such an issue on their next read,
and the weekly sweep moves it to the triage state if no one has.

Requiring a priority and a size breaks a script that files through
`tracker.ts create` without them, so the check arrives in two releases.
Build step 2 ships it warning: an incomplete issue is filed, and the missing
facets are printed, in a minor release whose change note says the next
release refuses and what to add. Build step 3 ships the refusal, in a minor
release whose change note marks it **Breaking** and says what a filing must
now carry (before 1.0.0 a breaking change asks for a minor release).

### Caught at the pools

Every pool read already carries each issue's facets, so an issue filed
around the check is seen on the next read, not a week later. `work-batch`
leaves out an issue that lacks a priority or a size and lists it as a
labelling gap, as it does an issue with no size today. `do-item` reads a
missing type as `unknown`, whose depth stops an unattended run until a type
is set ([work types](work-types.md)), and its status line names any other
missing facet. The dispatcher picks up only items a trusted person
assigned, so it does not refuse one for a missing facet; its tick record
counts the assigned items that lack one.

### The weekly sweep

`file-issue/scripts/check-fields.ts` sweeps the open issues through
`incompleteIssues`, so it works on every adapter. It lists each issue that
lacks a type, a priority or a size (no size on an epic), or carries a
retired label (a facet's label where that facet is kept elsewhere), and, in
its default mode, moves each one not yet started back to the `triage` state
with a comment naming the missing facets, so the move carries its reason in
the tracker's history. With `--comment-only`, or `issue_tracker.facets.sweep:
comment` in the configuration (default `move`), it posts the comment and moves
nothing, for a repository whose people triage in place. The comment is posted first and carries a marker naming the issue's
missing facets; a run that stopped between the comment and the move finds the
marker on the next run, moves the issue and posts nothing again. An issue
already started is listed, not moved, since moving it would take it from the
session working it. An issue already in triage is not read again, so each
issue is moved and commented on once. In comment-only mode the issue stays in the queried population, so the
marker alone keeps the sweep to one comment per issue and set of missing
facets: a run that finds the marker posts nothing, and posts again only when
the missing facets change. A capped read would let the same first issues,
already commented, take every run's pages, and no order that depends on the
sweep's own writes can advance past them, since a run that finds the marker
writes nothing. So in this mode the read keeps a position: pages are ordered
oldest first, a creation order that no write changes, and the run records the
key of the last issue it read in the state the sweep keeps between runs (on
Jig's workflow, its cache). The next run resumes after that key, and a read
that reaches the end of the population starts again from the first issue. An
issue whose missing facets change after its comment is revisited when the
position comes round to it, which is within as many runs as the population
holds capped reads. A run with no recorded position starts from the first
issue.

Its bounds:

- **A run is capped.** It reads at most 20 pages of 100 issues and moves at
  most 50; what remains is moved by the next run, which starts from the
  issues still outside triage. The read pages over issues not yet started
  only, so the same started issues cannot take the budget run after run.
- **Writes are paced.** At most 30 a minute (a move and its comment are
  two); a `Retry-After` is honoured up to 3 times, and on the fourth refusal
  the run stops and reports how many it moved and how many remain.
- **A store problem moves nothing.** When more than half of the open issues
  outside triage that must carry a facet, by the tracker's own counts, lack
  that facet, or
  `facetStores()` reports a configured store whose health fails closed, it
  moves none and
  reports the store and detection result instead, since that is a store
  that stopped answering, not a pile of bad filings.
- **It prints keys, not content.** Each line is an issue key and its missing
  facets, never a title or a body, so a public workflow log holds nothing a
  private tracker does not show.

On Jig's repository a weekly workflow, `.github/workflows/issue-fields.yml`,
runs the sweep, declared with its cadence in `.config/scheduled-jobs.yaml`
like every scheduled workflow. It runs with the workflow's own token and
`permissions: { contents: read, issues: write }`, and no other secret: after
its move Jig's configuration names every store, so the sweep checks store
health only and makes no organization read; a denied discovery read never
stops it, while a facet whose store the configuration leaves unnamed needs
detection, and a sweep that cannot run it fails and moves nothing. The workflow runs the sweep only, never the move. A
consumer runs the same command on its own schedule, with a tracker
credential that may read issues and move them to triage; the dispatcher's
tick records already catch an incomplete issue in its pools, so the sweep
is for issues no pool reads. The audit names a repository that keeps facets
and runs no sweep.

### Moving a repository from one store to another

`check-fields.ts move` moves facets between any two stores, labels to
fields, fields to labels and field to field. Its target is the
`issue_tracker.facets` section the repository will commit, given as a file
(`--target <file>`), so the switch commits exactly what the copy wrote; its
source is the section in force when the move starts, which the preview
writes into the move record (`--record <file>`) beside the target. Copy,
resume and retire all take that record (`--record <file>`) and read both
sections from it, so the source stays named after the switch commits the
target, and a field-to-field move still names its old field. A person runs it; the scheduled workflow
never does. Each run is one pass over the open issues, at most one update
per issue, carrying every facet it moves. Writes are paced and honour
`Retry-After` as the sweep's are. It changes nothing without `--yes`, and
with `--yes` it adds to that record every issue it
changed: for each store it touched, the issue's value before and after,
whether a label, an issue type or a field value, the labels it added as well
as the ones it took off. `move --restore <file> --yes` puts every recorded
before-state back.

Each phase is complete for an issue on its own condition, so a run that
stopped is resumed by running it again:

- **Copy** is complete when the destination holds the source's value.
- **Retire** is complete when the destination is valid and the source
  representation is gone (the source labels are off, or the source field is
  cleared). A copied issue is not skipped by retire. An issue whose
  destination is cleared or unmapped is never retired: it is listed as
  unresolved, with its remaining source value, until a person settles it.

1. **Preview.** `move --target <file> --record <file>` without `--yes` lists what each
   issue would get, and the issues whose source gives no value or two.
   Such an issue is **unresolved**: a person gives it one value in its
   source first. Copy refuses to start while any open issue is unresolved,
   and retire never removes a source representation it has not verified
   copied.
2. **Give the organization the fields** where they are missing: issue types
   named like the taxonomy's types, and Effort options that are the
   taxonomy's sizes (the default Priority field already names the
   priorities); or a `values` map to the names it already uses. Before
   adding a field, `facetStores()` in each repository of the organization
   shows which ones it would reach: only those that keep no labels for that
   facet and name no store.
3. **Copy.** `move --record <file> --copy --yes` sets every open issue's
   destination value from its source, keeps the source as it is, and writes
   the value it copied into the record as the copy snapshot.
4. **Switch.** The person commits the target section to the repository's
   configuration. Filings write the new stores from then on.
5. **Retire.** `move --record <file> --retire --yes` reads each open issue
   again and compares its source with the copy snapshot. An unchanged source
   is retired once its destination is valid. A source someone changed since the copy, with the
   destination still at the snapshot, has its new value written to the
   destination first and is then retired. A source and a destination both
   changed since the copy conflict: the issue is left as it is and listed, and
   the run is not complete until a person settles each one. An issue with no
   snapshot (one the copy missed, or one filed through a clone still on the
   old configuration) is not told apart by when it was filed: both
   representations are read. A source value alone is copied and retired in
   one update; a destination value alone is left as it is and checked as for
   any other; both, and equal, retire the source; both, and different, are a
   conflict listed for a person.
   The source representation is removed only where the source is a label or
   a field; a destination label is never removed. Closed issues keep their
   labels as history, and no label is deleted while a closed issue carries
   it, so the ledgers' priority history is never erased.

A move writes at most twice per open issue (the copy and the retire) and
never touches a closed issue; at 30 writes a minute, a run over 1,000 open
issues takes about 35 minutes, and a repository's move is a person's
preview, those two runs and one configuration commit. Going back is the
same command with the old section as its target, or `--restore` with the
record, followed by reverting the configuration commit.

### Compatibility

- **No repository's store of record moves** on an upgrade. A repository
  that keeps a facet in labels keeps filing and reading those labels on
  every adapter until its configuration names another store.
- **GitHub Issues**: a repository with no labels for a facet and no store
  named, such as a new one, uses its organization's matching field from
  build step 2, the release in which the callers read the facets.
- **Detection is the one prerequisite step 2 adds.** Build step 1 only
  reports detection through `facetStores()` and the audit. From step 2 a
  facet with no named store waits on it, label-backed repositories included,
  so a repository that reads and files with a credential that cannot read
  its organization, or whose issue forms or people set native values beside
  its labels, names its stores first. The audit and `facetStores()` print
  the lines to add, and step 2's change note says this in its first
  sentence, so no repository meets it as a failed read.
- **Jira** files every new issue as the one configured `issue_type`, as
  today, until `issue_tracker.facets.type` names the issue type as its
  store; `field_labels` keeps reading as it does.
- **Linear** changes nothing: priority stays the priority field, type and
  size stay labels, and the estimate is used only where `size` says
  `store: native`.
- **Filing** without a priority, or without a size on an issue that is not
  an epic, warns from build step 2 and is refused from build step 3, each
  in a minor release whose change note says so.

### Jig's own repository

Jig moves to GitHub's stores once the move exists (build step 3). Its
organization's issue types are its taxonomy's types, Bug, Feature, Docs,
Chore and Infra: a person retires GitHub's default Task type from the
organization before the move, so the web interface offers no type that
names nothing. Its Priority field has the default options, and its Effort
field's options are `xs`, `small`, `medium`, `large` and `xl`, so its
configuration names the stores (`store: native` for type and priority,
`store: field` with `field: Effort` for size) and needs no value map. Its
`issue_tracker.types` keeps mapping `docs`, `chore` and `infra` to the
`task` work type. Its open issues then carry no type, priority or size
label, and its closed issues keep theirs. Until the move its configuration
names the label store for each of the three facets (`store: label`), set in
the pull request of build step 2 that adds types to the issue forms: the
forms then carry both the type and the type label without making type a
conflict, and no read of Jig's repository waits on detection. The move
replaces those three entries with the native ones and drops the form labels.

## Build order

Each step is one pull request, and each states the GitHub read cost it
measured.

1. **The interface, the label store and GitHub's stores, all as today by
   default.** `port.ts`: the facets on `Issue`, `PoolIssue`, `NewIssue` and
   `IssuePatch`, `PoolQuery.facets`, `incompleteIssues()` and
   `facetStores()`. `config.ts` and the new `facets/` (`config.ts`,
   `values.ts`, `label.ts`, `detect.ts`): `issue_tracker.facets`, today's
   keys read as their facet's form, and every adapter's default left at
   today's stores. `github/tracker.ts`, `github/read.ts`, `github/reports.ts`,
   `github/model.ts`, `github/settings.ts` and the new `github/facets.ts`:
   the issue type and the Priority and Effort fields as stores a repository
   names, in every write and in every issue and pool read, and detection
   reported by `facetStores()` without choosing anything. `linear.ts` and
   `jira/tracker.ts` carry the facets with today's behaviour.
   `do-item/scripts/tracker.ts`: `create` and `update` take the facets.
   `plugin/CONFIGURATION.md`, `plugin/EXTENDING.md`, a change note
   (`release: minor`), the adapters' tests, the fake transport returning a
   timeout, a rate limit and a refusal to detection. Done when a repository
   that sets nothing files, reads and pools exactly as before (a store named
   for type or size before step 2 is for the scratch run below only: the
   callers read labels until step 2), in the same
   order; on a scratch issue of Jig's repository with the stores named in an
   overlay, `tracker.ts create` with type `bug`, priority 2 and size `small`
   files a Bug with Priority High and Effort `small` and none of them as a
   label; a failed detection read is an error, never labels; and the pull
   request states the measured query cost and latency before and after.
2. **The callers, the filing check warning, and GitHub's field default.**
   `do-item/scripts/determine_type.ts` and `lib/work-types.ts`: the type from
   the facet. `work-batch` (`candidates.ts`, `lib/eligibility.ts`,
   `lib/policy.ts`): the pool, the gaps and the batch sizes from the size
   facet. `facets/complete.ts` and `lib/tracker/index.ts`: the check inside
   `createIssue`, warning. `file-issue/scripts/lib/validate.ts`,
   `validate-labels.ts` and `SKILL.md`: the check takes the facets and asks
   for a priority. `resolve-review-comments/scripts/file-deferred.ts`,
   `defer-in-pr.ts`, `lib/deferred-section.ts` and the deferral protocol:
   the entry records type, severity and category, and the filing sets every
   facet; `defer-batch.ts`'s `SEVERITY_TO_PRIORITY`: `unknown` as medium, with
   `priorityReflectsSeverity` and `priorityAfterSeverity` and their tests
   revised to match: they compare severity ranks, and `unknown` ranks below
   every real severity today, so an existing priority is left alone in the
   append path. After the change `unknown` has the medium floor: a priority
   weaker than medium is raised to it, a stronger one stays.
   `jig/scripts/report-bug.ts`: the Bug type. `.github/ISSUE_TEMPLATE/bug.yml`
   and `change.yml`: their types beside their labels, priority and size left
   to triage, and `.config/jig.yaml` naming `store: label` for type, priority
   and size in the same pull request, so the forms never put native evidence
   beside labels the configuration has not pinned.
   `facets/detect.ts`: GitHub's field default for a repository that keeps no
   labels for the facet. `plugin/dispatch/tick.ts` and its receipt: each
   facet's store and the pool's gaps in the tracker record.
   `label-taxonomy.yaml`: size not required on an epic. M9's README and its
   taxonomy template; `CONTRIBUTING.md`: file through `/jig:file-issue` or
   `tracker.ts create`, both checked. The audit skill re-scored against the
   change. A change note (`release: minor`) saying first that a facet with no
   named store now waits on organization detection, and which repositories
   name their stores before upgrading (Compatibility), then that the next
   release refuses an incomplete filing, and that a GitHub repository with
   no labels for a facet now uses its organization's matching field.
   Done when `tracker.ts create` without a priority warns naming the
   missing facet and files; a finding filed by `file-deferred.ts` carries a
   type, a priority and a size; an issue opened from the bug form is a Bug;
   and a pool read lists an issue that lacks a facet as a gap.
3. **The move, the weekly sweep, and the refusal.** `check-fields.ts` with
   its sweep and its move (preview, copy, retire, restore record);
   `file-issue/SKILL.md` and `README.md`; `.github/workflows/issue-fields.yml`
   and `.config/scheduled-jobs.yaml`; `facets/complete.ts`: an incomplete
   filing refused; the audit naming a repository that keeps facets and runs
   no sweep. A change note marked **Breaking**. Done when a move on
   the fake tracker writes at most one update per open issue per run, skips
   the issues a stopped run already moved, and is undone by `--restore`; and
   the sweep stops at its caps and at a refused write, reporting what
   remains. Owed by a person after the merge: the Task type retired from
   Jig's organization, then Jig's move, after which no
   open issue of Jig carries a type, priority or size label, its closed
   issues keep theirs, its configuration names its stores, its pools read in
   the same order as before, and the sweep lists no issue.
4. **The Jira and Linear stores**, last, so the GitHub path is proven
   first. The Jira stores are what a site's custom issue types and custom
   fields need; the Linear estimate comes with them as the option the
   defaults name. `jira/tracker.ts`, `jira/read.ts`, `jira/client.ts`,
   `jira/settings.ts` and the new `jira/facets.ts`: the
   issue-type map, and a custom field read and written as a facet,
   `field_labels` included. The new `linear-facets.ts`: size in the
   estimate, mapped onto the team's estimate scale, and refused where the
   scale has fewer points than the sizes or estimates are off.
   `plugin/CONFIGURATION.md`, `plugin/EXTENDING.md`, a change note, the
   tests against the fake Jira and Linear. Done when, on the fakes, a `bug`
   of size `medium` is filed as the mapped issue type with the size field
   set and reads back as both, and a Linear team with estimates reads and
   writes size through the estimate. Owed by a person: the same on a live
   Jira project (a create, a read and an update of an issue type and a
   custom field, and one issue of each mapped type moved through the states
   `issue_tracker.states` names) and on a live Linear team for each
   estimate scale it uses, since the fakes carry their author's
   assumptions.

## Later: the command store

A store kept by the repository's own command, for a facet no other store
can express (a value derived from two Jira fields, or kept in a service of
the repository's own), is not built until a repository names the facet it
needs it for. It is a command per facet, not a whole adapter kept as a
script: the interface's other operations stay in code. It must meet these
constraints:

- **Only the repository sets it, from its default branch.** It is one of
  the fields only a repository sets (`REPOSITORY_ONLY_FIELDS`), refused in
  the user file, an environment variable and an overlay file. A caller a
  timer starts (the dispatcher's tick, the weekly sweep) reads it from the
  default branch, as the dispatcher reads its own section, and runs the
  program that branch holds, never a copy in a working tree on another
  branch.
- **Its environment is scrubbed, and that is not containment.** It runs
  without the tracker and forge tokens the adapters read (`GH_TOKEN`,
  `GITHUB_TOKEN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `LINEAR_API_KEY`,
  `LINEAR_API_TOKEN`), so they stay out of its environment and its logs.
  It still runs as the same user, who can read the `gh` and `linear`
  logins and any file that user can, so what bounds it is the review of the
  default branch that names it.
- **Its output is checked and bounded.** One JSON object of at most 64 KiB,
  each value checked against the facet's closed list before any caller
  sees it; anything else fails the read.
- **It is batched.** One run per page of issues, runs one at a time, a
  deadline per run and per read, and a cache per dispatcher tick.
- **Read-only callers do not run it** (`jig ask`, the audit,
  `facetStores()`) unless the repository allows them to.
- **Its failures are redacted** to the same one bounded line as every
  store's, before they reach a receipt, a dashboard or a log.
- **Its changes have a history**: the store it reads records who changed a
  value, or the command reports it.

## Left out

- **Fixing the filing paths only, on today's stores.** It is the cheaper
  path, and it closes the gaps the count shows: `file-deferred.ts`,
  `report-bug.ts` and the forms fixed, the check in `tracker.ts create`,
  the sweep. It leaves type and size with no value in the interface and
  every adapter's store fixed in code, so a Jira site's custom issue types
  and fields, or a GitHub organization's fields, stay out of reach. Overruled
  by the person accepting this design.
- **A whole adapter as an external script.** The interface has an
  operation for every read and write the skills make, and the next adapter
  is planned as code ([plan.md](plan.md) item 12); the command per facet,
  when a repository needs it, covers what no store expresses.
- **Every field shown as a label**, as `jira.field_labels` does, so no
  caller changes. It leaves type and size with no defined value in the
  interface.
- **An opt-in switch for GitHub's fields.** A repository that keeps no
  labels for a facet uses its organization's field without one, and a
  repository that keeps labels moves when its configuration names the
  field.
- **Facets beyond type, priority and size**, such as a due date, a team or
  an owning repository. They stay labels or Jira `field_labels`; one joins
  when a caller needs to read it.
- **The deferral batch step's own Linear path** (`defer-batch.ts`), which
  files outside the interface and already sets priority from severity,
  through the shared mapping that files `unknown` as medium. It joins the
  check when the deferral moves onto the interface (plan item 10).
- **Records.** `reflect`'s issues are records, not work, carry no facets,
  and are never read by the sweep.
- **A host timer for the sweep.** Jig's repository runs it as a workflow; a
  host job like the dispatcher's joins when a consumer without CI asks for
  one.

## Review

Critiqued on 2026-11-06 against commit a42b8306 by a red-team by persona
(critical-cto, security-auditor, performance-engineer, cost-optimizer),
each reading the design with fresh context. The report is
[in the pull request](https://github.com/jig-harness/jig/pull/520#issuecomment-6691611279).
