---
name: file-issue
description: "File a tracker issue from the discussion, or plan an existing one (re-label, split into sub-issues, relate): write a durable body, derive labels from the change's areas or its description, check them against the repository's label taxonomy, search for duplicates, confirm, then write through the tracker scripts."
argument-hint: "[title or summary] | plan <issue-key>"
allowed-tools: "Read Grep Glob Write Bash(bun *) Bash(git *) AskUserQuestion"
---

# File issue — put work on the tracker, labelled and checkable

Turn what was just discussed into a tracker issue a person or an agent can
pick up weeks later, or bring an existing issue into the same shape. The
issue gets a body that survives the code moving under it, labels drawn only
from the repository's
[label taxonomy](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
and checked against it before anything is written, a search for a
duplicate first, and its sub-issues and relations recorded in the tracker.

Without this skill, filing is improvised: labels are guessed from memory, a
facet goes on without its umbrella, a gate's flag lands on the epic instead
of the item that ships the change, and the same problem is filed twice.

This is the runnable form of
[M9 — Tasks & memory](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/README.md):
a closed taxonomy whose flags fire processes, and issues filed with their
taxonomy, priority and category set at creation. The human page is
[README.md](README.md).

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of
the directory containing this `SKILL.md`. Claude Code fills it in. In any
other harness, replace it with that path yourself before running a command:
a shell would expand the unset variable to an empty string. Sibling skills
are reached the same way, e.g.
`${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts`.

Run every command from the root of the repository the issue belongs to.
Never `cd` into the skill directory: the scripts find the repository and its
configuration from the working directory.

### How to read the step markers

- **exact** — follow as written; substitute only the documented inputs and
  explicitly supported options.
- **judgment** — the shape shown is illustrative; keep the required fields,
  guards and data flow.

### Consumer configuration

The skill reads `.config/jig.yaml` through the plugin's configuration
reader; to read one value yourself, run
`bun "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/jig-config.ts" <field>`.

| Field | What it sets | When absent |
|-------|--------------|-------------|
| `issue_tracker.taxonomy` | The label taxonomy, relative to the repository root | `label-taxonomy.yaml`; without one the skill stops before writing |
| `issue_tracker.team` | The tracker team the issues are filed in | Required: the tracker scripts stop with a message naming it |
| `issue_tracker.adapter` | Which tracker adapter the tracker scripts use | The default adapter |
| `issue_tracker.labels` | The label each role names (`hitl`, `manual_ops`, `epic`, `followup`, `bug`, `pattern_prefix`); `tracker.ts labels` prints them | The defaults in the [configuration reference](../../CONFIGURATION.md#issue_tracker) |
| `drive.change_areas_catalog` | The change-area catalog labels are derived from when a diff exists | No catalog: labels come from the description |
| `review.taxonomy.categories` | The category list an issue's category is checked against (with `unknown`, always allowed) | No list: the category is `unknown` |

The taxonomy's own schema (types, statuses, flags, groups, categories) is
described in the header of
[M9's template](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/templates/label-taxonomy.yaml).

### Tracker operations

Every read and write goes through the tracker scripts of the `do-item`
skill, which reach the tracker the repository configured. Never call a
tracker by another route.

| Operation | Command |
|-----------|---------|
| Label roles | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" labels` |
| Labels the tracker has | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" available-labels` |
| Search issues | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" search "<text>"` |
| Get an issue | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/get_issue.ts" <KEY>` |
| Its comments | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/list_comments.ts" <KEY>` |
| Its relations | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" relations <KEY>` |
| Create an issue | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" create < issue.json` |
| Change an issue | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" update <KEY> < patch.json` |
| Relate two issues | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" relate <KEY> <blocks\|related\|duplicate> <TARGET>` |

`issue.json` is `{ "title", "description", "labels": [...], "priority"?,
"parent"?, "project"? }`; `patch.json` sets any of `title`, `description`,
`priority`, `parent` (`null` removes it), `project`, `addLabels`,
`removeLabels`. Labels are passed by name. Priority is `0` (none), `1`
(urgent), `2` (high), `3` (medium) or `4` (low). Write each file with the
Write tool under `.context/`, never by interpolating text into a shell
command.

### Asking the user

Where this skill says "ask the user", use `AskUserQuestion` under Claude
Code where the session can use it; in any interactive harness where it
cannot (another harness, or a permission mode that denies the tool), ask a
plain-text numbered question and end the turn. With nobody to answer, stop and state the question rather
than write anything. Never pick on the user's behalf.

## Modes

- `/jig:file-issue [title or summary]`: file a new issue from the
  discussion ([File](#file-a-new-issue)).
- `/jig:file-issue plan <KEY>`: plan an existing issue: re-label it, split
  it into sub-issues, record its relations ([Plan](#plan-an-existing-issue)).

## The rules every write obeys

**exact** — These hold in both modes.

1. **Validate before every write.** Every label set that will be written
   (a new issue's, a child's, an existing issue's labels after the change)
   passes `validate-labels.ts` with `--check-tracker` first:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/validate-labels.ts" --check-tracker <label>...
   ```

   Exit `0`: valid (read any `WARNING` and act on it or say why not). Exit
   `3`: invalid; fix the labels it names and run it again. Exit `1`: the
   taxonomy is missing or fails its lint, or the tracker could not be read;
   stop and report it, and write nothing. Exit `2`: a usage error in your
   command.
2. **Only taxonomy labels.** A label the taxonomy lacks is a change to the
   taxonomy, not to this issue: say so and leave it off. Never create a
   label in the tracker from here.
3. **A gate's flag goes on the item that ships the change.** A flag whose
   `scope` is `shipping-item` goes on the issue (or sub-issue) whose pull
   request makes the change, never on the container above it; a
   `container` flag (an epic) goes on the container. When an issue is
   split, move such a flag from the parent to the children that carry the
   change.
4. **Confirm before writing.** Show the user the complete plan (titles,
   labels, priority, parent, relations, the body) and write only after they
   accept it.
5. **No guessing a facet.** A facet the taxonomy marks optional (a category
   whose `requires` names an umbrella) is left off when unsure: the
   umbrella alone is a complete labelling, and a wrong facet is worse than
   none. A facet the taxonomy requires (a flag's `requires_category`) is
   asked for.

## File a new issue

### 1. Load the taxonomy and the label roles

**exact** — Check the taxonomy, then read it and the label roles:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/check-label-taxonomy.ts"
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" labels
```

A failing lint ends the run: report its problems; no issue can be labelled
against a taxonomy that does not hold. Then read the taxonomy file itself
(the path `issue_tracker.taxonomy` names, else `label-taxonomy.yaml`): each
family's labels, each flag's `apply_when` and `do_not_apply_when`, and the
`requires` rules are what the later steps choose by. The roles say which
label is the human-in-the-loop flag (`hitl`), the operator-step flag
(`manual_ops`), the epic flag, the review follow-up flag, and the prefix of
a recurring pattern's label.

### 2. Read the discussion

**judgment** — From the conversation (and `$ARGUMENTS`, when given), extract:
the problem and for whom; why it matters now; what done looks like; the
approach discussed, if any; open questions. Draft a title (imperative, one
line), the type, a size (when the taxonomy has a size group), a
priority, and a category.

The **category** is a classification of its own (a security issue and a
performance one can share a severity), never derived from the priority. Take
it from the discussion, or from the finding when the issue defers one, and
check it against the repository's category list:

```bash
bun "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/jig-config.ts" review.taxonomy.categories
```

It must be one of that list or `unknown` (with the field not set, only
`unknown`). When nothing says which it is,
write `unknown` rather than a guess. It is recorded in the body (step 5),
not as a label: it is not part of the label taxonomy.

### 3. Ask only what is missing

**judgment** — When a fact the issue needs is genuinely absent or
ambiguous (scope, the acceptance criteria, a dependency, the priority),
ask the user up to four questions at once, each with concrete options.
Otherwise skip this step. Offering "file a draft with my best guesses" as
one option is fine; say which fields are guesses.

### 4. Search for a duplicate

**exact** — Search with two or three phrasings of the problem (its key
terms, the error text, the component):

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" search "<terms>"
```

It searches open issues; add `--include-closed` when the problem may have
been fixed or declined before, and put `--` before text that itself starts
with `--`. Read every plausible hit (`get_issue.ts <KEY>`). When one already covers
the problem, ask the user: add what is new to that issue instead (a comment
or, in plan mode, a change), file anyway and relate the two (`related`), or
file the new issue and mark the new one as the duplicate of the existing one
(`relate <NEW> duplicate <EXISTING>`, never the other way round: the tracker
may close the issue marked as the duplicate). Never file a second copy
silently.

### 5. Write the body

**judgment** — Start from
[`templates/issue-body.md`](templates/issue-body.md) and fill what
applies. The body must survive the code moving before someone picks it
up:

- **Behaviour, not locations.** Say what the system should do, naming
  stable things (types, interfaces, endpoints, configuration keys, table
  and column names, decision records), never file paths or line numbers as
  the instruction.
- **What, not how.** The person or agent that picks it up explores the
  code fresh and decides the implementation; record a decision already
  made, and leave the rest open.
- **Verifiable acceptance criteria**, each checkable on its own: the
  command, test or observable result that proves it. "Works correctly" is
  not one.
- **Out of scope**, whenever the change sits near code someone might be
  tempted to fix on the way.
- **The category** from step 2, on the template's `**Category**:` line.
- **The repository's own terms**, from its glossary, where it has one.
- **An operator checklist** when the issue carries the `manual_ops` role's
  label: every concrete step a person performs outside the code after the
  merge, with no placeholder left. Do not file a `manual_ops` issue
  without it.
- **What a person must decide** when it carries the `hitl` role's label,
  and who.
- **The pattern** when it is a bug of a recurring class (and carries a
  `<pattern_prefix><slug>` label): the class, why it recurs, and the other
  occurrences found.
- **The source** when it is a review follow-up (the `followup` role's
  label): the review thread and the pull request it came from.

No reviewer dialogue, no "as discussed above", no reference to a branch or
commit that may be gone by then.

### 6. Derive the labels

**exact** when a diff exists and the repository has a change-area catalog,
**judgment** otherwise. Read whether it has one first:

```bash
bun "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/jig-config.ts" drive.change_areas_catalog
```

`... is not set in any layer` (exit `2`) means no catalog: take the
description path below, even with a diff.

**With a diff and a catalog** (the issue follows a change already made or
under review), resolve the diff against the catalog and take the tracker
projection, the `linear` field of the resolver's JSON (`labels` and
`flags`):

```bash
set -o pipefail
BASE=$(git merge-base origin/main HEAD) &&
  { git diff -z --no-renames --name-only "$BASE" &&
    git ls-files -z --others --exclude-standard; } |
  bun "${CLAUDE_SKILL_DIR}/../change-areas/scripts/resolve.ts" --files - -z
```

(Use the repository's base branch for `origin/main`.) Apply those labels
and flags as they are; do not join the catalog's areas to labels by hand.
The projection comes from the **seed areas** only, the areas a changed
file matches directly, never from the implied areas the catalog's
`impliedBy` closure adds. The closure answers "what could this change
affect?", the right question for which reviews and deploys to run; labels
answer "what did this change touch?", and a label from the closure is a
lasting false claim on the issue record (an interface-change flag on a
change that touched only build scripts, because the build area implies a
service that implies the interface). When a flag the change clearly needs
is missing from the projection because no directly matched area carries
it, that is a gap in the catalog: say so (and file it if the user agrees),
and add the flag here from the description instead; never fall back to the
closure.

**Without a diff or without a catalog**, choose each label from the
description, against the
taxonomy's `apply_when` and `do_not_apply_when` for every flag and the
`notes` of every label.

Then complete the set, in both cases:

- exactly one **type**;
- one label of every **required group** (a size, a repository), and at
  most one of any group;
- a label of every **recommended category** that fits, within its `max`;
- the **flags** whose condition holds, scoped as rule 3 says, with what
  each `requires` beside it;
- the `hitl` label when a person must decide, with a facet of each category
  its `requires_category` names (otherwise a facet only when certain, as
  rule 5 says); the `manual_ops` label when a step outside the code is needed
  (and the checklist from step 5); the `followup` label when the issue
  defers a review finding.

### 7. Decide on sub-issues

**judgment** — Split when the work spans independent deliverables (two
areas that can ship separately, a part that needs a person beside a part
that does not), or it is larger than the taxonomy's largest size that one
pull request should carry. Do not split tightly coupled work, or a small
issue. When splitting, ask the user, showing the proposed children, what
each delivers, its labels and the order between them.

- The **parent** keeps the outcome and the acceptance criteria of the
  whole, the type, the repository and the area labels, and no
  shipping-item flag. It carries the epic flag only when it is the unit
  progress is reported on, needs more than one pull request, and never
  becomes a pull request itself.
- Each **child** is one deliverable with its own durable body, its own
  size, and the flags its own change fires. A child a person must decide
  carries the `hitl` label (with the facets the taxonomy requires beside
  it), and its body opens with what the person must decide.
- Record the order: a child that must land first `blocks` the next.

### 8. Validate every label set

**exact** — Run `validate-labels.ts --check-tracker` (rule 1) on the
parent's set and on each child's. Every set passes before step 9.

### 9. Confirm

**exact** — Show the user the plan: each issue's title, labels, priority,
parent and relations, and each issue's body in full, children's included:
the body is what step 10 writes. Write nothing until the user
accepts; apply their changes and validate again.

### 10. Write

**exact** — Create the parent (or the single issue) first, then each child
with `"parent": "<PARENT-KEY>"`, each from its own JSON file:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" create < .context/file-issue/<n>.json
```

Each prints the new issue's key and URL. On a failure, stop: report which
issues were created (with their keys) and which were not, and do not retry
blindly, which could file a copy.

### 11. Record the relations

**exact** — For each relation agreed in step 7 or found in step 4:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" relate <KEY> blocks <TARGET>
```

`<KEY> blocks <TARGET>` means `<TARGET>` waits for `<KEY>`; a "blocked by"
is written from the other side. `<KEY> related <TARGET>` links the two either
way. `<KEY> duplicate <TARGET>` means `<KEY>` is a duplicate of `<TARGET>`:
`<KEY>` is the copy and the tracker may close it, `<TARGET>` is the issue
that stays. Never mark an existing issue as the duplicate of one filed in
this run. `relations <KEY>` reports each relation from `<KEY>`'s side:
`blocks`, `blocked_by`, `related`, `duplicate` (`<KEY>` is the duplicate)
and `duplicated_by` (the other issue is a duplicate of `<KEY>`).

### 12. Report

**exact** — End with:

```markdown
## Filed <KEY>: <title>

- Labels: <labels> (warnings: <any, or none>)
- Priority: <priority> · Category: <category>
- Parent: <key, or none> · Sub-issues: <keys, or none>
- Relations: <KEY blocks …, related …, or none>
- Next: `/jig:do-item <KEY>` (or the first child to pick up)
```

## Plan an existing issue

### 1. Read the issue

**exact** — Fetch it, its comments and its relations:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/get_issue.ts" <KEY>
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/list_comments.ts" <KEY>
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" relations <KEY>
```

Then load the taxonomy and the label roles as in
[File, step 1](#1-load-the-taxonomy-and-the-label-roles).

### 2. Assess the labels and the body

**judgment** — Check the issue's labels against the taxonomy (run
`validate-labels.ts` on them as they are) and against what the issue
describes, deriving as in [File, step 6](#6-derive-the-labels). Keep each
existing label unless the assessment replaces it; replacing a group's
label means removing the old one, since a group holds one. Where the body
is not durable ([File, step 5](#5-write-the-body)), propose a rewritten
body that keeps every fact the old one had.

### 3. Split, if it should be

**judgment** — As in [File, step 7](#7-decide-on-sub-issues). When the
issue is split, move each shipping-item flag from it to the children whose
change fires it; existing children (`get_issue.ts` lists them) count
toward the split.

### 4. Validate, confirm, write

**exact** — Validate the issue's resulting label set and every new child's
([rule 1](#the-rules-every-write-obeys)); show the user the change (labels
added and removed, the new body if any, the children, the relations) and
write only after they accept.

Create the children first, with `"parent": "<KEY>"`, as in
[File, step 10](#10-write), so each flag moving from the issue to a child
is on the child before it leaves the issue. Only once every child exists,
change the issue:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" update <KEY> < .context/file-issue/patch.json
```

with `addLabels` and `removeLabels` rather than a whole label list. When a
child cannot be created, stop before the update: the issue keeps its flags,
so no flag is lost, and report which children exist (with their keys) and
which do not. Do not retry blindly; ask the user whether to create the rest
or remove the ones created. When the update itself fails after the children
exist, report that the issue still carries the flags its children now carry,
and the update that would remove them. Then record the relations as in
[File, step 11](#11-record-the-relations). Report as in
[File, step 12](#12-report), headed `## Planned <KEY>: <title>`.
