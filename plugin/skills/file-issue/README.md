# file-issue

Files tracker issues that a person or an agent can pick up weeks later, and
brings existing issues into the same shape. Its sweep finds the open issues
filed without a type, a priority or a size, and its move carries those
three from one place in the tracker to another.

An issue filed by hand drifts in two ways. Its labels are picked from
memory: a facet goes on without the label it refines, two size labels end
up on one issue, a flag that should start a review lands on the epic
instead of the sub-issue whose pull request makes the change, so the review
never runs where the change is. And its body points at files and line
numbers that have moved by the time anyone reads it. This skill writes the
body to describe behaviour, chooses labels only from the repository's
[label taxonomy](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
checks them mechanically before anything is written, and looks for a
duplicate first.

It is the runnable form of
[M9 — Tasks & memory](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/README.md),
and holds that module's label checks: the taxonomy lint and the label
validator. The agent's procedure is [SKILL.md](SKILL.md).

## Use it

```text
/jig:file-issue                     # file an issue from the conversation
/jig:file-issue Add CSV export      # the same, with a title to start from
/jig:file-issue plan ENG-123        # re-label, split or relate an existing issue
/jig:file-issue plan #123           # the same, on GitHub Issues
/jig:file-issue check               # list open issues missing a type, priority or size
/jig:file-issue move                # move type, priority and size to another store
```

Filing goes: read the taxonomy, read the discussion, ask only what is
missing, search the tracker for a duplicate, write the body, derive the
labels, propose sub-issues when the work splits, validate every label set,
show you the whole plan, and only after you accept it create the issues and
their relations. Planning reads the issue, its comments and its relations
and proposes a change the same way.

The confirmation follows the repository's
[autonomy level](https://github.com/jig-harness/jig/blob/main/plugin/CONFIGURATION.md#autonomy).
Under `attended`, the default and every session a person runs unless they
chose otherwise, you see the plan first. Under `unattended`, which a drive's
pass reads where the repository allows it, an issue another skill needs (a
deferral, a follow-up, a reflection escalation) is filed without the
confirmation, and its body ends with a line saying which skill filed it,
from which pull request and why, so you can find it and close it. Planning
an existing issue always asks.

Every tracker read and write goes through the
[do-item](https://github.com/jig-harness/jig/blob/main/plugin/skills/do-item/SKILL.md)
skill's tracker scripts, so the skill works with whichever tracker adapter
the repository configured.

## Set it up

1. Write the repository's label taxonomy: start from
   [M9's template](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/templates/label-taxonomy.yaml),
   whose header documents the schema, and keep only the labels the tracker
   uses. Commit it as `label-taxonomy.yaml` at the root, or anywhere with
   `issue_tracker.taxonomy` pointing at it.
2. Make sure every label in it exists in the tracker, once and under exactly
   that name: compare the taxonomy with what the `available-labels` operation of `tracker.ts`
   (in the `do-item` skill) lists. the `--check-tracker` mode of `validate-labels.ts`
   checks only the labels of the set it is given, so it finds a missing
   label when an issue first uses it, not before.
3. Optionally set `issue_tracker.file_command: /jig:file-issue`, so the
   other skills that file issues (`do-item`, `decide`, `reflect`, …) tell
   the agent to file through this one.
4. Run the lint in CI on any change to the taxonomy (below).
5. Run the [weekly sweep](#the-weekly-sweep) on a schedule, so an issue
   filed around the tracker scripts is caught.

| Field | Default | What it sets |
|-------|---------|--------------|
| `issue_tracker.taxonomy` | `label-taxonomy.yaml` | The label taxonomy, relative to the repository root |
| `issue_tracker.team` | none (required on Linear) | Linear only: the team the issues are filed in, the prefix of their keys (`ENG` in `ENG-123`) |
| `issue_tracker.labels` | the default roles | Which label is the human-in-the-loop flag, the operator-step flag, the epic flag, the review follow-up flag and the pattern prefix |
| `drive.change_areas_catalog` | none | The change-area catalog labels are derived from when a diff exists |
| `review.taxonomy.categories` | none | The category list an issue's category is checked against; `unknown` is always allowed |

The [configuration reference](https://github.com/jig-harness/jig/blob/main/plugin/CONFIGURATION.md#issue_tracker)
has every field.

## The label taxonomy

A taxonomy is a closed vocabulary in families:

- **types**: what kind of work an issue is; exactly one per issue.
- **statuses**: the workflow states; not labels, listed so the vocabulary
  is complete.
- **flags**: labels that fire a process (a review, a block on closing, a
  human checkpoint). Each says what it fires, which item it goes on and
  when it applies, and may require other labels beside it.
- **groups**: other single-select families, such as a size or a
  repository: at most one label of each, and one when the group is
  required.
- **categories**: multi-select families whose labels share a prefix
  (`area:billing`, `area:search`). A category can be open (any slug
  matching a pattern, for a vocabulary that grows, such as the class of a
  recurring bug; the pattern must match the whole slug, so `[a-z]+`
  accepts `flaky` and refuses `Foo bar`), can warn above a number of labels or when none is
  present, and can require an umbrella label beside its own: a facet never
  appears without the label it refines.

### The lint

`scripts/check-label-taxonomy.ts` keeps the file honest: unique label
names, closed non-empty types and statuses, every flag firing something
with a scope and a rule for when it applies, every group with labels,
every category with a prefix that no other prefix begins and with labels
or an open pattern that compiles, no type, flag or group label inside a
category's prefix, every `requires` naming a label of the file, and no
unknown key (at the top level or in any entry) or repeated key.

```bash
bun <plugin>/skills/file-issue/scripts/check-label-taxonomy.ts [label-taxonomy.yaml]
```

Without a path it reads `TAXONOMY`, else `issue_tracker.taxonomy`, else
`label-taxonomy.yaml`. Exit `0` passes, `1` lists the problems, `2` is a
usage error or a missing file. Run it as a CI step on any change to the
taxonomy; it is cheap enough to run always.

### The label validator

`scripts/validate-labels.ts` checks one issue's label set against the
taxonomy, before the issue is written:

```bash
bun <plugin>/skills/file-issue/scripts/validate-labels.ts [--taxonomy <path>] [--json] [--check-tracker] <label>...
bun <plugin>/skills/file-issue/scripts/validate-labels.ts bug small app
```

It rejects (exit `3`) an empty label or one with whitespace around its
name, a label the taxonomy does not define, an open
category's label whose slug does not match, no type or two, two labels of
one group or none of a required group, a label whose `requires` is unmet
(a facet without its umbrella), and a flag without a label of a category
it requires. It warns, without failing, above a category's `max` and when
a recommended category is absent. `--check-tracker` also rejects a label
the tracker does not have and a name the tracker has more than one label
of, matching names exactly, case included, as the tracker scripts do when
they write. Exit `1` means the taxonomy is missing or fails
the lint, or the tracker could not be read; `2` is a usage error. `--json`
prints `{ valid, labels, errors, warnings, parsed }`.

## Labels from the change

When the issue follows a change and the repository has a change-area
catalog, the labels come from the repository's
[change-area catalog](https://github.com/jig-harness/jig/blob/main/plugin/skills/change-areas/README.md):
the areas the diff touches carry the labels and flags to apply. Only the
areas a changed file matches directly count, never the areas they imply.
Implied areas answer "what could this change affect?", which is right for
deciding which reviews to run, where running one too many costs little.
Labels answer "what did this change touch?", and a label from an implied
area is a lasting false claim on the record, such as an interface-change
flag on a change that touched only build scripts. A flag the change needs
that no directly matched area carries is a gap in the catalog, to be fixed
there.

Without a diff or without a catalog, the labels come from the description,
against each flag's written conditions in the taxonomy.

## The weekly sweep

Every issue filed through the tracker scripts carries a type, a priority
and a size: the tracker refuses one without them (an epic needs no size).
An issue filed another way, from an issue form or with the forge's own
command, can still arrive without them, and an issue with no priority is
not low priority but unranked, so no pool can work it in order. The pools
report such an issue the next time they read it; the sweep catches the
ones no pool reads.

```bash
bun <plugin>/skills/file-issue/scripts/check-fields.ts check          # report only
bun <plugin>/skills/file-issue/scripts/check-fields.ts check --yes    # and move them to triage
```

It reads every open issue outside triage through the tracker interface, so
it works on every tracker, and lists each one that lacks a type, a
priority or a size, or carries a label of a facet the repository now keeps
in the tracker's own field. With `--yes` it moves each one not yet started
back to triage, with a comment naming what it lacks; one already started
is listed and left where it is, since moving it would take it from whoever
is working it. The comment goes first and carries a hidden marker, so a
run that stopped before the move finishes it next time without a second
comment.

It reads one tracker census within a minute, shared across the listing
pages and the started-issue list. The listing holds at most 20 pages of
100 incomplete issues; this bounds the report, not the size of that census.
It moves at most 50 issues a run, writes paced at 30 a minute, a `Retry-After` waited out up to
3 times; a refused write stops the run, which reports what it moved and
what remains. When more than half of the issues that must carry a facet
lack it, or a store fails closed, it moves nothing and reports the store
instead: that is a store that stopped answering, not a pile of bad
filings. It prints issue keys, never a title or a body, so a public CI log
holds nothing the tracker does not show.

Schedule it weekly with a tracker credential that may read issues,
comment on them and move them to triage. On GitHub Issues a workflow's own
token does, with `permissions: { contents: read, issues: write }`, when the
configuration names every facet's store (a facet left to the default needs
a credential that can read the organization's issue types and fields).
GitHub's `Retry-After` reaches the sweep only over the HTTPS transport, so
there set `JIG_GITHUB_GRAPHQL_URL=https://api.github.com/graphql` beside
the token: through `gh`, a rate limit stops the run at once. Exit `0` means
it ran (a report without `--yes` still names a store problem it found);
`1` a store problem that kept it from reading anything or, with `--yes`,
from moving anything, a failed read, or a refused write; `2` a usage error.

## Moving to another store

A repository keeps each facet in a store: labels, the tracker's own field
(GitHub's issue type and Priority field, Jira's issue type), or a custom
field such as an Effort field. The move, `check-fields.ts` in its `move`
mode, carries facets from one store to another, labels to fields, fields
to labels, or field to field, for every open issue. It writes nothing
without `--yes`.

1. **Preview**: `move --target target.yaml --record record.json`, with the
   `issue_tracker.facets` section the repository will commit in
   `target.yaml`. It lists what each open issue would get, and the issues
   whose source gives a facet no value or two, which a person settles
   first. The record it writes keeps the section in force now beside the
   target.
2. **Give the tracker the fields** the target names, where it lacks them:
   an issue type per type, an option per size.
3. **Copy**: `move --record record.json --copy --yes` sets each open
   issue's new store from its old one, and keeps the old one.
4. **Switch**: commit the target section to `.config/jig.yaml`.
5. **Retire**: `move --record record.json --retire --yes` takes the old
   store's labels off (or clears its field) on each issue whose new store
   holds the value. Where someone changed the old store since the copy,
   the new value is copied first and retired by the next run; where both
   changed, the issue is left as it is and listed for a person.

Each run writes at most one update per open issue, paced as the sweep's,
and a run that stopped is resumed by running it again. Closed issues are
never touched, so they keep their labels as history, and no label is ever
deleted. `move --restore record.json --yes` puts back every value the
record says the move changed, then revert the configuration commit. The
exit codes: `0` done, `3` something left for a person or the next run
(each listed by key), `1` a failed read or a refused write, `2` usage.


Migration writes recheck the live source and destination after pacing and
before each attempt. A changed issue is left as a conflict. The tracker
interface has no atomic conditional update, so a person can still change
an issue between that final read and the remote write. Run a move while
other writers are idle. Commands using the same local record are serialized.
Restore keeps the recorded alias labels, including their original spellings.

A move refuses overlapping source and destination stores, including native
GitHub priority and the named Priority field, and in-place value-map changes.
An unmapped nonempty destination must be mapped before copying; it is never
overwritten as though it were empty. Jira's required native priority cannot
be retired, so a move from that store is refused before copying.


## A durable issue body

The body is written for a reader who arrives after the code has moved
([template](templates/issue-body.md)):

- what the system should do, naming stable things (types, interfaces,
  endpoints, configuration keys, tables), not file paths or line numbers;
- what to achieve, not how: the implementer decides;
- acceptance criteria that can each be checked on their own;
- what is out of scope, where neighbouring code invites a detour;
- an operator checklist of concrete steps when a person must act outside
  the code after the merge, and what a person must decide when the issue
  needs a human checkpoint.

## Files

| File | Role |
|------|------|
| `SKILL.md` | The agent's procedure |
| `scripts/check-label-taxonomy.ts` | The taxonomy lint |
| `scripts/validate-labels.ts` | The label validator |
| `scripts/check-fields.ts` | The weekly sweep and the move between stores |
| `scripts/lib/sweep.ts` | The sweep's reads, moves and bounds |
| `scripts/lib/move.ts`, `scripts/lib/move-record.ts` | The move's phases and its record |
| `scripts/lib/pace.ts` | How the sweep and the move pace their writes and report a failure |
| `scripts/lib/sections.ts` | The `issue_tracker.facets` sections a move goes between |
| `scripts/lib/taxonomy.ts` | The schema and the lint's rules |
| `scripts/lib/validate.ts` | The validator's rules |
| `templates/issue-body.md` | The issue body skeleton |
| `__tests__/` | The self-tests, with good and bad taxonomy fixtures |
