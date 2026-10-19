# file-issue

Files tracker issues that a person or an agent can pick up weeks later, and
brings existing issues into the same shape.

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
and holds that module's two label checks: the taxonomy lint and the label
validator. The agent's procedure is [SKILL.md](SKILL.md).

## Use it

```text
/jig:file-issue                     # file an issue from the conversation
/jig:file-issue Add CSV export      # the same, with a title to start from
/jig:file-issue plan ENG-123        # re-label, split or relate an existing issue
```

Filing goes: read the taxonomy, read the discussion, ask only what is
missing, search the tracker for a duplicate, write the body, derive the
labels, propose sub-issues when the work splits, validate every label set,
show you the whole plan, and only after you accept it create the issues and
their relations. Planning reads the issue, its comments and its relations
and proposes a change the same way.

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
   that name (`validate-labels.ts --check-tracker` reports any that do not).
3. Optionally set `issue_tracker.file_command: /jig:file-issue`, so the
   other skills that file issues (`do-item`, `decide`, `reflect`, …) tell
   the agent to file through this one.
4. Run the lint in CI on any change to the taxonomy (below).

| Field | Default | What it sets |
|-------|---------|--------------|
| `issue_tracker.taxonomy` | `label-taxonomy.yaml` | The label taxonomy, relative to the repository root |
| `issue_tracker.team` | none (required) | The tracker team the issues are filed in |
| `issue_tracker.labels` | the default roles | Which label is the human-in-the-loop flag, the operator-step flag, the epic flag, the review follow-up flag and the pattern prefix |
| `drive.change_areas_catalog` | none | The change-area catalog labels are derived from when a diff exists |

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
or an open pattern that compiles, every `requires` naming a label of the
file, and no unknown key or repeated key.

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
echo '["bug", "small", "app"]' | bun <plugin>/skills/file-issue/scripts/validate-labels.ts
```

It rejects (exit `3`) a label the taxonomy does not define, an open
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

When the issue follows a change, the labels come from the repository's
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

Without a diff, the labels come from the description, against each flag's
written conditions in the taxonomy.

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
| `scripts/lib/taxonomy.ts` | The schema and the lint's rules |
| `scripts/lib/validate.ts` | The validator's rules |
| `templates/issue-body.md` | The issue body skeleton |
| `__tests__/` | The self-tests, with good and bad taxonomy fixtures |
