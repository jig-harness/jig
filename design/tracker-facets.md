# Issue facets: type, priority and size wherever the tracker keeps them: design

**What problem this solves.** A team sorts and filters its issues by what
kind of work each one is (its type), how soon it matters (its priority) and
how much work it is (its size). Jig's skills read the same facts: `do-item`
sets how deep each station goes from the type, and `work-batch` ranks by
priority, sends an urgent issue alone and batches only small sizes. Today
one repository keeps each of these facts in several ways at once, depending
on the tracker and on who filed the issue: in the tracker's own field, in a
label, or nowhere. A tracker whose types are half in labels and half in its
own field cannot be filtered by type, and an issue filed without a priority
is not low priority but unranked
([M9](../modules/M9-tasks-memory/README.md#priority-and-category-at-birth)),
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
with a default per adapter that uses the tracker's own fields where it has
them. Callers read the value, never the label or field behind it. Every
path that files an issue writes each facet, one check run where the write
happens refuses an issue that lacks one, and a weekly check catches the
issues filed around it.

Its plan item is not in [plan.md](plan.md) yet. It changes `do-item`'s
tracker interface ([`port.ts`](../plugin/skills/do-item/scripts/lib/tracker/port.ts))
and its adapters, and the callers that read type, priority and size: the
[work-type](work-types.md) derivation, `work-batch`, the
[dispatcher](../GLOSSARY.md)'s pools and `file-issue`.

## The rule

> Every work item carries a type, a priority and a size beside its labels.
> The tracker interface holds each as a **canonical value**; where the
> tracker keeps it is configuration, per facet, with a documented default
> per adapter. Callers read the value and never parse the place it is kept.
> Every path that files an issue writes each of them, and **one check, run
> where the write happens**, refuses an issue that lacks one.

This is M9's rule of
[priority and category at birth](../modules/M9-tasks-memory/README.md#priority-and-category-at-birth),
widened from the priority to the type and the size, and moved from one
skill into the write itself.

## How it works

### The facets and their values

| Facet | Canonical value | Where the values come from |
| --- | --- | --- |
| `type` | a type name, or `null` for none | the closed `types` list of the repository's [label taxonomy](../GLOSSARY.md), which `issue_tracker.types` maps to [work types](../GLOSSARY.md) |
| `priority` | `1` (urgent), `2` (high), `3` (medium), `4` (low), or `0` for none | fixed; the configuration names them `urgent`, `high`, `medium` and `low` |
| `size` | a size name, or `null` for none | the taxonomy's `size` group (Jig's: `xs`, `small`, `medium`, `large`, `xl`) |

Priority keeps the numbers the interface already uses (`PoolIssue.priority`,
`NewIssue.priority`). A type or a size is the id the taxonomy declares,
whatever the tracker shows: on Jig's repository the type `docs` is the
issue type Docs, and in a repository that keeps types in labels it is the
label `docs`.

A type and a work type stay two things. The type is what the tracker
records (Jig's taxonomy has `bug`, `feature`, `docs`, `chore` and `infra`).
The work type is how deep `do-item` goes, derived from the type through
`issue_tracker.types` (Jig maps `docs`, `chore` and `infra` to the `task`
work type). This design makes the type a value of the interface; the
derivation and its depth table stay as [work types](work-types.md)
describes them, its first step reading the type facet instead of labels.

### Stores

A store is where a tracker keeps one facet:

- `native`: the tracker's own field for that fact;
- `field`: a custom field the repository names;
- `label`: a label per value, named one by one or by a prefix;
- `command`: the repository's own command, which reads and writes the
  value however the repository keeps it.

What each tracker can hold:

| Store | GitHub Issues | Jira | Linear |
| --- | --- | --- | --- |
| `native` type | the issue type | the issue type | refused: Linear has no issue types |
| `native` priority | the organization's Priority issue field | the priority field | the priority field |
| `native` size | refused: an Effort issue field is a `field` | refused: each site's estimate is a custom field | the estimate |
| `field` | an issue field of the repository's organization | a custom field, by name or id | refused: the adapter has no custom field to name on Linear |
| `label` | any facet | any facet | any facet |
| `command` | any facet | any facet | any facet |

A store the adapter cannot hold is refused when the configuration is read,
naming the facet and the stores that adapter has.

### Value maps

A `native` or `field` store keeps values in the tracker's own vocabulary,
so it maps each canonical value to one tracker value: an issue type's name,
a field option's name, or a number. A `label` store maps each value to one
label. Each map is one to one, ignoring case, so a value read back names
exactly one canonical value, and a map that gives two canonical values one
tracker value is refused when the configuration is read.

A canonical value the map leaves out takes the tracker value of its own
name, matched ignoring case (`bug` is the issue type Bug, `small` the option
small). A tracker value that names no canonical value, such as an issue
type Incident nobody mapped, reads as none, and the weekly check reports
the issue. A map value that names nothing on the tracker (an issue type the
organization does not have) is refused at the first write that needs it,
before anything is written, naming the value and what the tracker has: the
way a label that resolves to nothing is refused today.

### Defaults per adapter

A repository that sets nothing gets these stores:

| Facet | GitHub Issues | Jira | Linear |
| --- | --- | --- | --- |
| Type | the issue type, matched by name; a type with no issue type of its name stays a label | the issue type, matched by name (`feature` → Story) | labels from `issue_tracker.types`; Linear has no issue types |
| Priority | the organization's Priority field; `priority:` labels where it has none | the priority field | the priority field |
| Size | the organization's Effort field, when its options carry the size names; size labels otherwise | none until a field is named, since each site's estimate field differs | size labels; the estimate as an option |

**On GitHub the fields are detected, never switched on.** The adapter reads
the organization's issue types and issue fields once per run. A Priority
field counts when its options name the priorities (Urgent, High, Medium and
Low, ignoring case), and an Effort field when its options name the
taxonomy's sizes. A repository a person owns has neither, so it keeps
labels. A type with no issue type of its name, such as `docs` in an
organization that has only Bug, Feature and Task, keeps its label; GitHub
asks for no issue type on an issue, so nothing else is set.

**On Jira every issue has an issue type.** A type with no issue type of its
name is filed as `issue_tracker.jira.issue_type` and keeps its value in its
label. An issue created under a standard issue is a sub-task, as today, and
keeps its type in its label too. How such an issue reads back is an
[open question](#open-questions).

### Configuration

One section, `issue_tracker.facets`, holds an entry per facet; an entry
left out takes its adapter's default. For example, a Jira repository that
keeps type in the issue type, priority in labels of its own, and size in a
number field:

```yaml
issue_tracker:
  facets:
    type:     { store: native, values: { bug: Bug, feature: Story, task: Task, spike: Spike } }
    priority: { store: label, labels: { urgent: P0, high: P1, medium: P2, low: P3 } }
    size:     { store: field, field: customfield_10016, values: { xs: 1, small: 2, medium: 3, large: 5, xl: 8 } }
```

A facet kept by the repository's own command:

```yaml
issue_tracker:
  facets:
    size: { store: command, command: [bun, scripts/size-facet.ts], timeout_seconds: 30 }
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `issue_tracker.facets.<facet>.store` | `native`, `field`, `label` or `command` | the adapter's default above | Where the facet is kept |
| `….values` | map from a canonical value to the tracker's value | each value by its own name | `native` and `field`: the issue type, option or number that holds each value |
| `….field` | a field's name or id | none; required by `field` | `field`: the custom field, a GitHub issue field by name, a Jira field by name or id (`customfield_10016`) |
| `….labels` | map from a canonical value to a label | the value's own name; on GitHub, priority's `priority: <name>` | `label`: the label of each value |
| `….prefix` | a label prefix | none | `label`: each value's label is the prefix followed by the value (`size:small`); refused beside `labels` |
| `….command` | a list of words | none; required by `command` | `command`: the program and its arguments, run without a shell |
| `….timeout_seconds` | whole number | `30` | `command`: how long one run may take |

Outside GitHub, a priority kept in labels needs `labels` or a `prefix`,
since a Jira label holds no whitespace and so cannot take GitHub's default.

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
| `issue_tracker.types` | It keeps mapping work types to type values. Where the type facet is kept in labels, the names it lists are the labels: `task: [docs, chore, infra]` lists type values, each the label of its own name, all of them `task` work |
| `issue_tracker.labels.bug` | The labels of the `bug` type in a label store, as it is today an alias of `issue_tracker.types.bug` |
| `issue_tracker.github.priority_labels` | The priority facet's `labels` |
| `issue_tracker.jira.field_labels` | An entry whose values are a facet's values (a `Size` field whose labels are the size group's) is that facet's `field` store, now written as well as read, and its values still show as labels; any other entry reads as labels, as it does today |
| `issue_tracker.jira.issue_type` | The issue type of a new issue whose type has no issue type of its own name, and of one created under an Epic |

A repository that set any of these keeps working with no change to its
file.

### The interface

`port.ts` changes:

- `Issue` gains `type: string | null`, `priority: number` and
  `size: string | null`. `PoolIssue` and `LedgerIssue` gain `type` and
  `size` beside the `priority` they have.
- `NewIssue` gains `type?` and `size?` beside `priority?`. `IssuePatch`
  gains `type?` and `size?`, where `null` removes the value.
- `PoolQuery` gains `facets?: { type?: string[]; size?: string[] }`: an
  issue matches when its value is one of the list. `work-batch` selects its
  pool by size this way instead of by size labels. An adapter filters in
  its query where the tracker's query language can (a label, a JQL clause),
  and otherwise filters the issues its query returned; either way a pool is
  read whole or not at all.
- `Tracker` gains `facetStores()`: each facet's effective store, and on
  GitHub what was detected (the field and its options), so the check and a
  person can see where a value is kept without reading the adapter.

Every read carries the facets on every issue it returns, pools and ledgers
included. On GitHub the issue type and the field values join the fields
each read already requests (today the issue type is read only where an
issue is fetched alone), so no read makes an extra request. Priority's `0`
stays "none" on every adapter: a Jira issue always has a priority, and one
whose priority no map names reads as `0`, as it does today.

### Reading and writing a facet

The code shared by every adapter lives in a new `lib/tracker/facets/`
folder: `config.ts` (the section, the defaults and today's keys),
`values.ts` (the value maps and their reverse), `label.ts` (the label store)
and `command.ts` (the command store). Each adapter keeps its `native` and
`field` stores beside its own code: `github/facets.ts`, `jira/facets.ts`,
and `linear-facets.ts` beside `linear.ts`, which is already past the
[file-size limit](../docs/adr/ADR-0007-source-file-size-ratchet.md).

A write takes the canonical value and writes it to its store, in the
create request itself where the tracker allows: GitHub's `createIssue`
takes the issue type (`issueTypeId`) and the issue field values
(`issueFields`), and Jira's create takes the issue type and custom fields.
A change replaces the old value: an update writes the new issue type or
field value (on GitHub through `issueFieldUpdates`), and in a label store
the old label comes off as the new one goes on, as the GitHub adapter's
priority labels do today.

### The command store

For a facet no other store can express: a value derived from two Jira
fields, or kept in a service of the repository's own. The adapter runs the
command from the repository root with one JSON object on its standard input:

```json
{ "op": "read", "facet": "size", "adapter": "jira",
  "issue": { "key": "ENG-12", "id": "10042", "url": "https://example.atlassian.net/browse/ENG-12", "labels": ["area:billing"] } }
```

A write has `"op": "write"` and the canonical `"value"`. A read prints
`{ "value": … }` (a canonical value, or `null`); a write prints `{}`.
Anything else, a non-zero exit, or a run past `timeout_seconds` fails the
operation with the command's output. On create the command runs once the
tracker has filed the issue, since it needs the key; a failing command is
reported with the new issue's key, so a person completes that issue rather
than filing it twice. The adapter passes the command no credential: one
that needs more of the issue than it is given reaches the tracker with its
own. It is configuration like `do_item.gates`, run with the same trust:
whoever can change the repository's configuration chooses the command.

### Checked where the write happens

One function checks a new issue before it is written: a type, a priority
(`1` to `4`) and a size, for each facet that has a store, with no size
required on an issue carrying the epic label (`issue_tracker.labels.epic`);
and a label of every required group of the taxonomy, the size group's
requirement being met by the size facet in whatever store it is kept. It
lives in `file-issue/scripts/lib/validate.ts` beside the label check it
extends, and runs where the write happens, so a new filing path cannot skip
it by not being `file-issue`:

| Path | Today | With this built |
| --- | --- | --- |
| `file-issue` | writes through `tracker.ts create`; type and size as labels, priority optional | the same command, which now runs the check; priority required |
| `tracker.ts create` (`do-item`) | checks shape | runs the check before `Tracker.createIssue`, refusing an incomplete issue with the missing facet named |
| `file-deferred.ts` | the follow-up label only | runs the check; the type from the finding, the priority from the [severity mapping](../GLOSSARY.md) M9 names, the size `small` unless the entry names one |
| `report-bug.ts` | `gh issue create` with the `bug` label | sets the Bug issue type where the account may set types |
| The issue forms | a label | `type: Bug` on the bug form, `type: Feature` on the change form |
| An agent by hand | whatever it sets | caught by the weekly check |

`file-deferred.ts` takes the type from the finding as the
[deferral protocol](../plugin/skills/resolve-review-comments/references/deferral-protocol.md#labels)
says (a deferred correctness finding is a `bug` whatever the pull request
was), so the entry `defer-in-pr.ts` writes into the pull request records the
type, the severity and the category `defer-batch.ts` already takes. M9
says the deferral path sets priority from the severity mapping; with this
built, the path that files through the interface does.

### The weekly check

`file-issue/scripts/check-fields.ts` reads the open issues through the
tracker interface, so it works on every adapter, and lists each one that
lacks a type, a priority or a size (no size on an epic), or carries a
retired label: a facet's label where that facet is kept elsewhere. It moves
each one it lists back to the `triage` state, so an issue filed by hand
waits for triage instead of being picked up unranked. It reads work, not
records: the issues `reflect`'s GitHub store writes are records with a
type of their own, and the check leaves them out.

On Jig's repository a weekly workflow, `.github/workflows/issue-fields.yml`,
runs the check, declared with its cadence in `.config/scheduled-jobs.yaml`
like every scheduled workflow. A consumer runs it on its own schedule.

### Compatibility

- **GitHub Issues** is the only adapter whose defaults change what a
  repository sees. A repository whose organization has issue types and a
  matching Priority or Effort field files into them from the first filing
  after the upgrade, and reads them. The step that brings this in ships as
  a minor release whose change note says how to keep labels: `store: label`
  on each facet.
- **Linear** changes nothing: priority stays the priority field, type and
  size stay labels, and the estimate is used only where `size` says
  `store: native`.
- **Jira** files a `bug` as a Bug instead of the one configured
  `issue_type`, since the type facet's default is the issue type matched by
  name; `field_labels` keeps reading as it does.

### Moving a GitHub repository from labels to fields

The fields are set on every open issue first, and the labels retired after:

1. **Keep labels while preparing.** Set `store: label` on each facet to
   move, so the upgrade changes nothing yet.
2. **Give the organization the fields.** Issue types named like the
   taxonomy's types, a Priority field with the options Urgent, High, Medium
   and Low, and an Effort field whose options are the taxonomy's sizes; or a
   `values` map to the names the organization already uses.
3. **Copy every value.** The check's move mode
   (`check-fields.ts move <facet>`) reads each open issue's value from its
   label and writes it to the field, keeping the label, and lists the issues
   whose labels give no value or two.
4. **Switch.** Run step 3 once more, so an issue filed since is copied too,
   then remove `store: label`: the adapter detects the fields and reads
   every value from them, and filings write them.
5. **Retire the labels.** The move mode takes each facet label off the
   issues and deletes the labels; the weekly check reports one that comes
   back.

### Jig's own repository

Jig takes GitHub's defaults. Its organization has an issue type for each of
its taxonomy's types (Bug, Feature, Docs, Chore and Infra, beside Task), a
Priority field whose options are the priorities, and an Effort field whose
options are `xs`, `small`, `medium`, `large` and `xl`, so the defaults match
by name and need no map. Its `issue_tracker.types` keeps mapping `docs`, `chore` and
`infra` to the `task` work type. An issue of type Task names no type of
Jig's taxonomy, so it reads as none and the weekly check reports it. Jig's
type, priority and size labels are retired once the callers read the
facets (build step 3), after every open issue has its fields set.

## Build order

Each step is one pull request.

1. **The interface, the label store and GitHub's stores.** `port.ts`: the
   facets on `Issue`, `PoolIssue`, `LedgerIssue`, `NewIssue`, `IssuePatch`
   and `PoolQuery`, and `facetStores()`. `config.ts` and the new `facets/`
   (`config.ts`, `values.ts`, `label.ts`): `issue_tracker.facets`, each
   adapter's defaults, and today's keys read as their facet's form.
   `github/tracker.ts`, `github/read.ts`, `github/reports.ts`,
   `github/model.ts`, `github/settings.ts` and the new `github/facets.ts`:
   the issue type and the Priority and Effort fields, detected per
   organization, in every write and in every issue, pool and ledger read.
   `linear.ts` and `jira/tracker.ts` carry the facets with today's
   behaviour (Linear's priority field and labels; Jira's priority and its
   one `issue_type`). `do-item/scripts/tracker.ts`: `create` and `update`
   take the facets. `plugin/CONFIGURATION.md`, `plugin/EXTENDING.md`, the
   change note (`release: minor`), the adapters' tests. Done when, on Jig's
   repository, `tracker.ts create` with type `bug`, priority 2 and size
   `small` files a Bug with Priority High and Effort `small` and none of
   them as a label; a repository with `store: label` on every facet files
   and reads the same labels as today; and the pools read in the same order
   as before the change.
2. **The Jira, Linear and command stores.** `jira/tracker.ts`,
   `jira/read.ts`, `jira/client.ts`, `jira/settings.ts` and the new
   `jira/facets.ts`: the issue-type map, and a custom field read and written
   as a facet, `field_labels` included. The new `linear-facets.ts`: size in
   the estimate, on the team's estimate scale. `facets/command.ts`: the
   command store. `plugin/CONFIGURATION.md`, `plugin/EXTENDING.md`, the
   change note, the tests against the fake Jira and Linear. Done when a
   `bug` of size `medium` is filed on the fake Jira as the mapped issue type
   with the size field set and reads back as both; a Linear team with
   estimates reads and writes size through the estimate; and a facet kept
   by a command is read and written through it, a failing command stopping
   the operation with its output.
3. **The callers and the filing check.** `do-item/scripts/determine_type.ts`
   and `lib/work-types.ts`: the type from the facet. `work-batch`
   (`candidates.ts`, `lib/eligibility.ts`, `lib/policy.ts`): the pool and
   the batch sizes from the size facet. `file-issue/scripts/lib/validate.ts`,
   `validate-labels.ts` and `SKILL.md`: the check takes the facets and
   requires a priority. `do-item/scripts/tracker.ts`: `create` runs the
   check. `resolve-review-comments/scripts/file-deferred.ts`,
   `defer-in-pr.ts`, `lib/deferred-section.ts` and the deferral protocol:
   the entry records type, severity and category, and the filing sets
   every facet. `jig/scripts/report-bug.ts`: the Bug type.
   `.github/ISSUE_TEMPLATE/bug.yml` and `change.yml`: their types.
   `label-taxonomy.yaml` and `.config/jig.yaml`: Jig's types kept as issue
   types, size not required on an epic. M9's README and its taxonomy
   template; `CONTRIBUTING.md`: file only through `/jig:file-issue`. The
   audit skill re-scored against the change. Done when `tracker.ts create`
   without a priority, or without a size on an issue that is not an epic,
   exits naming the missing facet; a finding filed by `file-deferred.ts`
   carries a type, a priority and a size; an issue opened from the bug form
   is a Bug; and, after the merge, no open issue of Jig carries a type,
   priority or size label, and those labels are deleted.
4. **The weekly report.** `file-issue/scripts/check-fields.ts` with its
   move mode; `file-issue/SKILL.md` and `README.md`: the `check` mode;
   `.github/workflows/issue-fields.yml` and `.config/scheduled-jobs.yaml`.
   Done when the check lists no issue on Jig's repository, and an issue
   filed with `gh issue create` and no fields is back in triage after the
   next weekly run.

## Left out

- **Every field shown as a label**, as `jira.field_labels` does, so no
  caller changes. It leaves type and size with no defined value in the
  interface, which is the gap this design closes.
- **A whole adapter as an external script.** The interface has an
  operation for every read and write the skills make, and the next adapter
  is planned as code ([plan.md](plan.md) item 12); a command per facet
  covers what no store expresses.
- **An opt-in switch for GitHub's fields.** It would leave every
  organization on labels until someone found the switch; a field the
  organization has is detected instead.
- **Facets beyond type, priority and size**, such as a due date, a team or
  an owning repository. They stay labels or Jira `field_labels`; one joins
  when a caller needs to read it.
- **The deferral batch step's own Linear path** (`defer-batch.ts`), which
  files outside the interface and already sets priority from severity. It
  joins the check when the deferral moves onto the interface (plan item 10).
- **Records.** `reflect`'s issues are records, not work, and carry no
  facets.
- **An epic as a Jira issue type.** The epic stays a label on every
  adapter, as it is today.

## Open questions

Each with the recommendation a person accepts or overrules before the step
that needs it.

1. **A type read from two places.** A GitHub type with no issue type of its
   name is a label beside an issue type that may be set by hand; a Jira
   issue whose type has no issue type is filed as `issue_type` (or as the
   sub-task type) and keeps its type in a label. When `issue_type` is
   itself a mapped value (`task` → Task) such an issue names two values.
   Recommendation: a value kept in a label wins over the fallback issue
   type (`issue_type`, the sub-task type); any other pair of different
   values reads as none, as two type labels make an item `unknown` in
   [work types](work-types.md), and the weekly check reports it. No
   fallback issue type is set on GitHub, which needs none.
2. **Several labels for one value.** `issue_tracker.types` and
   `issue_tracker.labels.bug` list several labels per value
   (`bug: [bug, type:bug]`), while a value map is one to one.
   Recommendation: the first label listed is the one written, and the
   others are read as the same value; no label may name two values, which
   loading already refuses.
3. **Facet labels in `Issue.labels`.** Hiding a facet's labels from an
   issue's labels, and refusing them as direct label writes, as the GitHub
   adapter does for priority labels, makes the facet the one way to set
   them, but would break `determine_type.ts` and `work-batch` before they
   read the facets. Recommendation: type and size labels stay visible in
   step 1 and become reserved in step 3, when the callers move.
4. **Whether a key of today chooses the store.** A GitHub repository that
   set `priority_labels`, in an organization that has a Priority field,
   may mean to keep labels or may predate the field. Recommendation: the
   key names labels and never chooses the store; the store comes from
   `issue_tracker.facets.<facet>.store` or the adapter's default, so one
   rule decides it everywhere, and the change note tells a repository to
   set `store: label` to keep labels.
5. **Jira's size with no field named.** "None" leaves a Jira repository
   whose taxonomy has a size group with no size in the interface, while the
   check still requires the size group's label and such a repository files
   size labels today. Recommendation: where the taxonomy has a size group
   and nothing else is named, size is kept in labels on Jira, as on the
   other adapters; "none" applies only to a repository with no size group.
6. **Size lists in other keys.** `issue_tracker.labels.batch_sizes`,
   `work_batch.sizes` and `size_points`, `routing.raise.sizes` and
   `review.taxonomy.sizes` name size labels. Recommendation: read each
   entry as a size value, or as the label of one, so an existing list keeps
   working whatever store the size moves to.
7. **`nativeType` beside `type`.** Recommendation: keep it, read-only, as
   what the tracker holds, for the derivation's evidence line and the weekly
   check's report of a type that maps to nothing; callers decide with
   `type`.
8. **A GitHub field whose options do not match.** An organization whose
   Priority field has the options P0 to P3 and no `values` map.
   Recommendation: labels, as for an organization with no field, and
   `facetStores()` says which field was seen and why it was not used.
9. **A label read while its field is still empty.** A repository that
   upgrades without reading the change note reads every priority as none
   until its fields are set. Recommendation: while a detected field holds
   no value, the facet's label is read in its place and the weekly check
   lists the issue as carrying a retired label; writes go to the field
   only, and take the label off.
10. **Closed issues in the move.** The debt ledgers read closed issues'
    priority, and deleting the labels in step 5 of the move erases it.
    Recommendation: the move mode copies the closed issues the ledgers read
    before it deletes the labels.
11. **A repository with no taxonomy.** Recommendation: the type values are
    the work types (the keys of `issue_tracker.types`, else the default
    list), and with no size group there is no size facet to require.
12. **A deferred finding of unknown severity.** The severity mapping turns
    `unknown` into no priority, which the check refuses, and an entry
    written before `defer-in-pr.ts` records type and severity has neither.
    Recommendation: an `unknown` severity files as medium, set once in the
    severity mapping so every path agrees; an entry with no recorded type
    stays in the section, reported as one a person files through
    `/jig:file-issue`.
13. **A command store read across a pool.** One run per issue makes a pool
    read one run per issue it holds. Recommendation: the read takes a list
    of issues and answers each, one run per page the adapter reads.
14. **An issue already started.** Moving an issue that is in progress or in
    review back to triage would take it from the session working it.
    Recommendation: the weekly check moves only issues not yet started and
    reports the rest.
