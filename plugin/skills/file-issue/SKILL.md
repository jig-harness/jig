---
name: file-issue
description: "File a tracker issue from the discussion, or plan an existing one (re-label, split into sub-issues, relate): write a durable body, derive labels from the change's areas or its description, check them against the repository's label taxonomy, search for duplicates, confirm, then write through the tracker scripts; or sweep open issues for a missing type, priority or size, or move those to another store."
argument-hint: "[title or summary] | plan <issue-key> | check | move"
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

| Field                        | What it sets                                                                                                                                      | When absent                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `issue_tracker.taxonomy`     | The label taxonomy, relative to the repository root                                                                                               | `label-taxonomy.yaml`; without one the skill stops before writing                                         |
| `issue_tracker.team`         | Linear and Jira: the team (Linear) or project (Jira) the issues are filed in, the prefix of their keys (`ENG` in `ENG-123`)                       | Required on Linear and Jira: the tracker scripts stop with a message naming it. Not used on GitHub Issues |
| `issue_tracker.adapter`      | Which tracker adapter the tracker scripts use                                                                                                     | The default adapter                                                                                       |
| `issue_tracker.labels`       | The label each role names (`hitl`, `manual_ops`, `epic`, `followup`, `bug`, `pattern_prefix`); the `labels` operation of `tracker.ts` prints them | The defaults in the [configuration reference](../../CONFIGURATION.md#issue_tracker)                       |
| `drive.change_areas_catalog` | The change-area catalog labels are derived from when a diff exists                                                                                | No catalog: labels come from the description                                                              |
| `review.taxonomy.categories` | The category list an issue's category is checked against (with `unknown`, always allowed)                                                         | No list: the category is `unknown`                                                                        |

The taxonomy's own schema (types, statuses, flags, groups, categories) is
described in the header of
[M9's template](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/templates/label-taxonomy.yaml).

### Tracker operations

Every read and write goes through the tracker scripts of the `do-item`
skill, which reach the tracker the repository configured. Never call a
tracker by another route.

| Operation              | Command                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Label roles            | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" labels`                                                 |
| Labels the tracker has | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" available-labels`                                       |
| Search issues          | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" search "<text>"`                                        |
| Get an issue           | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/get_issue.ts" "<KEY>"`                                              |
| Its comments           | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/list_comments.ts" "<KEY>"`                                          |
| Its relations          | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" relations "<KEY>"`                                      |
| Create an issue        | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" create --input issue.json`                              |
| Change an issue        | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" update "<KEY>" --input patch.json`                      |
| Relate two issues      | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" relate "<KEY>" <blocks\|related\|duplicate> "<TARGET>"` |

An issue key is `ENG-123` on Linear and Jira and `#123` on GitHub Issues, an issue
of the configured repository; this document writes it as `<KEY>` (or
`<TARGET>` for the other issue of a relation). Quote a key on a command line:
an unquoted `#` starts a shell comment.

`issue.json` is `{ "title", "description", "labels": [...], "type",
"priority", "size", "parent"?, "project"? }`; `patch.json` sets any of
`title`, `description`, `type`, `priority`, `size` (`type` and `size` take
`null` to remove), `parent` (`null` removes it), `project`, `addLabels`,
`removeLabels`. Labels are passed by name. The type, the priority and the
size are the issue's **facets**: give them in their own fields, never as
labels, since the tracker keeps each where the repository's configuration
says (labels, its own issue type, or a field) and refuses a facet's label
among `labels` or `addLabels`. Priority is `1` (urgent), `2` (high), `3`
(medium) or `4` (low); `0` (none) is for a correction only. Every filing is
checked inside the tracker for its applicable facets and required group
labels. An epic needs no size. On Jira, omit a facet kept in a custom field
when the selected issue type’s create screen lacks that field. Supplying it
produces a refusal naming the field and issue type. The weekly sweep reports
how many issues it passed over for each facet absent from both screens.
The tracker refuses an incomplete filing before writing (exit `2`) and
names what it lacks. Write each
file with the Write tool under `.context/scratch/`, never by interpolating
text into a shell command. A draft whose tracker write failed is the only
copy of its findings: move it out of `.context/scratch/` (to
`.context/unfiled/`) before ending, so worktree collection keeps it.

### Asking the user

Where this skill says "ask the user", use `AskUserQuestion` under Claude
Code where the session can use it; in any interactive harness where it
cannot (another harness, or a permission mode that denies the tool), ask a
plain-text numbered question and end the turn (one numbered line per option, the recommended one first and marked as the default where there is one, which the reply `default` takes). With nobody to answer, stop and state the question rather
than write anything. Never pick on the user's behalf. The one exception is
the confirmation of [step 9](#9-confirm) under the `unattended` autonomy
level, which the level itself answers.

## Modes

- `/jig:file-issue [title or summary]`: file a new issue from the
  discussion ([File](#file-a-new-issue)).
- `/jig:file-issue plan <KEY>`: plan an existing issue: re-label it, split
  it into sub-issues, record its relations ([Plan](#plan-an-existing-issue)).
- `/jig:file-issue check`: sweep the open issues for one without a type, a
  priority or a size, or carrying a label of a facet kept elsewhere
  ([Check](#check-the-open-issues)).
- `/jig:file-issue move`: move the repository's type, priority and size
  from one store to another, such as from labels to the tracker's own
  fields ([Move](#move-the-facets-to-another-store)).

## The rules every write obeys

**exact** — These hold in both modes.

1. **Validate before every write.** Every issue that will be written (a new
   issue, a child, an existing issue after the change) passes
   `validate-labels.ts` with `--check-tracker` first, its facets beside its
   labels: a new issue's JSON file (the one step 10 files), or an existing
   issue's labels after the change with its type, priority (1 to 4) and
   size:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/validate-labels.ts" --check-tracker --input .context/scratch/file-issue/<n>.json
   bun "${CLAUDE_SKILL_DIR}/scripts/validate-labels.ts" --check-tracker --type <type> --priority <priority> --size <size> [--native-type <issue type>] <label>...
   ```

   For an existing issue, pass `--native-type` the native type it will have
   after the change: its `nativeType` (from `get_issue.ts`) unless the change
   sets the native issue type itself; then the issue type the adapter
   resolves for the destination. Changing the type facet through labels or a
   field leaves the native type as it is, so an epic keeps meeting a
   `requires` naming the epic label when its label-backed type changes.

   For a Jira filing draft, the check uses the selected issue type’s create
   screen to determine which custom-field facets it requires. Exit `0`:
   valid (read any `WARNING` and act on it or say why not). Exit
   `3`: invalid; fix the labels it names and run it again. Exit `1`: the
   taxonomy is missing or fails its lint, or the tracker could not be read;
   stop and report it, and write nothing. Exit `2`: a usage error in your
   command.

2. **Only taxonomy labels.** A label the taxonomy lacks is a change to the
   taxonomy, not to this issue: say so and leave it off. Never create a
   label in the tracker from here.
   A label of a category the taxonomy marks `field_only: true` is a value
   the tracker keeps in a field it reads as labels but never writes (a Jira
   field behind `issue_tracker.jira.field_labels`, such as Fix versions as
   `fixversion:2.4`). `validate-labels.ts` lists it under `fieldOnly`, with
   a `WARNING`, and leaves it out of `labels`: leave it out of the `labels`
   of the JSON file [step 10](#10-write) files (the adapter refuses it).
   No Jig script writes that field, so never set the value yourself, by the
   tracker scripts or the tracker's own interface: it is a step a person
   owes in the tracker after filing, and the confirmation and the report
   name it as owed. Under a drive, record it with the filing (drive-pr
   § 8), so a person finds it.
3. **A gate's flag goes on the item that ships the change.** A flag whose
   `scope` is `shipping-item` goes on the issue (or sub-issue) whose pull
   request makes the change, never on the container above it; a
   `container` flag (an epic) goes on the container. When an issue is
   split, move such a flag from the parent to the children that carry the
   change.
4. **Confirm before writing, unless the autonomy level says nobody is
   there.** Show the user the complete plan (titles, labels, priority,
   parent, relations, the body) and write only after they accept it, under
   the `attended` level. Under `unattended`, write without the confirmation,
   and the body says which skill filed it, from which pull request and why
   ([step 9](#9-confirm)).
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
line), the type, any applicable size, a priority,
and a category. Every issue gets a priority: an issue
filed without one is not low, it is unranked, and no pool can work it in
order.

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
ambiguous (scope, the acceptance criteria, a dependency, the priority;
always ask for a priority the discussion does not give), ask the user up
to four questions at once, each with concrete options.
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
with `--`. Read every plausible hit (`bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/get_issue.ts" "<KEY>"`). When one already covers
the problem, ask the user: add what is new to that issue instead (a comment
or, in plan mode, a change), file anyway and relate the two (`related`), or
file the new issue and mark the new one as the duplicate of the existing one
(`relate "<NEW>" duplicate "<EXISTING>"`, never the other way round: the tracker
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
bun "${CLAUDE_SKILL_DIR}/../change-areas/scripts/resolve.ts" --worktree --base origin/main
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

Then complete the issue, in both cases:

- exactly one **type**, its size when applicable and its
  **priority**, given as the issue's facets rather than labels;
- one label of every other **required group** (a repository), and at most
  one of any group;
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

**exact** — Run the `--check-tracker` mode of `validate-labels.ts` (rule 1) on the
parent's issue and on each child's, each with its facets. While a child's
parent is not filed yet, check a copy of its JSON file that carries
`"parentPending": true`, so its placement is checked as a child's; that key
belongs to the check alone, so step 10 files the child from the file
without it (`create` refuses unknown keys). Every one passes before step 9.

### 9. Confirm

An already-decided review deferral in a drive uses the
[deferral protocol](../resolve-review-comments/references/deferral-protocol.md#who-decides-a-deferral)
and bypasses this step at every autonomy level.

**exact** — Read whether this run confirms. Name the skill that asked for the
issue (this one, or the one that called it), the pull request it came from,
and why, in one line:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/confirm-step.ts" --skill <skill> --pr <pull-request-url> --why "<one line>"
```

It prints `confirm: <level>` or `skip: <level>`, then the filed-by line.

- **`confirm`** (the `attended` level, and every interactive session unless
  its person chose a level): show the user the plan, each issue's title,
  labels, priority, parent and relations, and each issue's body in full,
  children's included: the body is what step 10 writes. Name each
  field-only value (rule 2) apart from the labels, as a step a person owes
  on the tracker field after filing. Write nothing until
  the user accepts; apply their changes and validate again.
- **`skip`** (the `unattended` level a driver pass reads where the repository
  allows it): put the printed filed-by line at the end of each issue's body,
  and go on to step 10. Under a drive, record the filing afterwards
  (drive-pr § 8), so a person finds and can close it. With no pull request
  behind the run, there is no `skip`: run the script with no options (it
  prints `confirm`) and confirm. On exit `2` (an empty or invalid option) fix
  the option and run it again; on exit `1` (an invalid autonomy
  configuration) treat the run as `confirm`, never as `skip`.

### 10. Write

**exact** — Create the parent (or the single issue) first, then each child
with `"parent": "<PARENT-KEY>"`, each from its own JSON file:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" create --input .context/scratch/file-issue/<n>.json
```

Each prints the new issue's key and URL. Exit `2` with `refused to file
an issue with no …` names what the issue lacks, and nothing was written:
add it to the issue's JSON, validate again (step 8) and file it. On any
other failure, stop: report which
issues were created (with their keys) and which were not, and do not retry
blindly, which could file a copy.

**The filing footprint** (**exact**), only when the issue follows a diff
in this workspace (the change step 6 resolved from it) or the person filing
named the paths the work will touch. It records those paths on the new
issue as its predicted
[footprint](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
as input for planned dispatcher admission. `--diff` reads this workspace's
change only: for a change under review, name the paths its pull request
changed instead. From this workspace's diff:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/write-footprint.ts" "<KEY>" --source filing --diff --base origin/main
```

(the repository's base branch for `origin/main`, as in step 6). From named
paths, write them one per line (a directory ending in `/`) to
`.context/scratch/file-issue/footprint-<n>.txt` and pass
`--paths <that file>` instead of `--diff`. Filed from a description alone,
write nothing: the labels already carry the areas, which a coarse
footprint can be derived from. With sub-issues, write each child's
own paths on that child, and none on an issue whose paths are not known:
never copy one diff onto every child. Exit `3` (no change, no path) wrote
nothing; any other non-zero exit is reported in step 13 and filing goes
on: the issue stands without its footprint.

### 11. Record the relations

**exact** — For each relation agreed in step 7 or found in step 4:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" relate "<KEY>" blocks "<TARGET>"
```

`<KEY> blocks <TARGET>` means `<TARGET>` waits for `<KEY>`; a "blocked by"
is written from the other side. `<KEY> related <TARGET>` links the two either
way. `<KEY> duplicate <TARGET>` means `<KEY>` is a duplicate of `<TARGET>`:
`<KEY>` is the copy and the tracker may close it, `<TARGET>` is the issue
that stays. Never mark an existing issue as the duplicate of one filed in
this run. `relations <KEY>` reports each relation from `<KEY>`'s side:
`blocks`, `blocked_by`, `related`, `duplicate` (`<KEY>` is the duplicate)
and `duplicated_by` (the other issue is a duplicate of `<KEY>`).

### 12. Hand it over, when asked

**exact** — Only when the person filing names who takes the work for the
line: the repository's factory identity (`dispatch.identity`) or a person
this host serves. Otherwise leave the issue unassigned and skip this step.
The issue was filed unassigned; never assign it in the creation itself or
by hand right after it. On a tracker whose history leaves out changes made
just after an issue's creation (the [creation window](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md#creation-window); Linear: its first three minutes), the
dispatcher never sees who made such an assignment and never starts the
item. Hand the issue (with sub-issues, the one to start, usually the
parent) over with the command for its taker, in the foreground and with
the command tool's timeout above four minutes: each waits until that window
has passed (up to about three minutes after the filing), then writes.

- **The factory identity**: `jig send pickup@<owner>/<name>#<KEY> assign`
  (`<owner>/<name>` is this repository). It also moves the item into a
  dispatch state the tick reads.
- **A served person**:

  ```bash
  bun "${CLAUDE_SKILL_DIR}/scripts/hand-off.ts" "<KEY>" --to "<their tracker identity>"
  ```

  It prints JSON: exit `0` with `confirmedAt` (the time the tracker's history confirmed the
  assignment with a trusted assigner, or `null` when the issue was already
  assigned and its history shows it); exit `3` when the issue was not handed over, with `reason`,
  `earliest` (the earliest time to run it again, when it waits on that) and
  `remedy`; exit `2` a malformed command line.

Neither changes an existing assignment. When the session cannot wait (it
ends, or the write fails), do not report the issue as handed over: put the
command, and the earliest time it may run, in the report so a person or the
next session finishes it. For an issue already assigned whose history does
not show the assignment, report the remedy as printed: unassign it on the
tracker, then assign it again after the window.

### 13. Report

**exact** — End with:

```markdown
## Filed <KEY>: <title>

- Labels: <labels> (warnings: <any, or none>)
- Owed on the tracker field, by a person (Jig does not write it): <each field-only value (rule 2), or none>
- Priority: <priority> · Category: <category>
- Parent: <key, or none> · Sub-issues: <keys, or none>
- Relations: <KEY blocks …, related …, or none>
- Footprint: <paths and areas recorded, or none (filed from a description)>
- Hand-off: <assigned to <identity> at <time>; the dispatcher sees it from its next tick after then | not handed over: <reason>; run `<command>` at or after <earliest time> | none asked>
- Next: `/jig:do-item <KEY>` (or the first child to pick up)
```

## Plan an existing issue

### 1. Read the issue

**exact** — Fetch it, its comments and its relations:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/get_issue.ts" "<KEY>"
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/list_comments.ts" "<KEY>"
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" relations "<KEY>"
```

Then load the taxonomy and the label roles as in
[File, step 1](#1-load-the-taxonomy-and-the-label-roles).

### 2. Assess the labels and the body

**judgment** — Check the issue's labels and its facets (the `type`,
`priority` and `size` `get_issue.ts` prints) against the taxonomy (run
`validate-labels.ts` on the labels without those that spell the type or
the size, which `get_issue.ts` keeps beside the facets and the validator
refuses as a second input, with `--type`, `--priority` and `--size`, and
with `--native-type` the native type it will have after the change (its `nativeType`
unless the plan sets the native issue type, then the adapter's resolved destination), so an issue typed as an epic
(`issue_tracker.labels.epic_types`) meets a `requires` naming the epic
label) and against what the issue describes, deriving as in
[File, step 6](#6-derive-the-labels). A missing priority is asked for, as
when filing. Keep each
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
write only after they accept. Planning an existing issue always confirms,
whatever the autonomy level.

Create the children first, with `"parent": "<KEY>"`, as in
[File, step 10](#10-write), so each flag moving from the issue to a child
is on the child before it leaves the issue. Only once every child exists,
change the issue:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" update "<KEY>" --input .context/scratch/file-issue/patch.json
```

with `addLabels` and `removeLabels` rather than a whole label list, and a
changed type, priority or size in its own field (`"type"`, `"priority"`,
`"size"`), which takes the old value off wherever it is kept. A
field-only value (rule 2) the issue shows among its labels is neither added
nor removed here: a change to it is a step a person owes on the tracker
field, and the report names it as owed. When a
child cannot be created, stop before the update: the issue keeps its flags,
so no flag is lost, and report which children exist (with their keys) and
which do not. Do not retry blindly; ask the user whether to create the rest
or remove the ones created. When the update itself fails after the children
exist, report that the issue still carries the flags its children now carry,
and the update that would remove them. Then record the relations as in
[File, step 11](#11-record-the-relations). Report as in
[File, step 13](#13-report), headed `## Planned <KEY>: <title>`.

## Check the open issues

**exact** — The sweep, `check-fields.ts`, reads every open issue outside
triage through the tracker interface. Report first; it writes nothing:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/check-fields.ts" check
```

It prints each facet's store and the tracker's counts, then, by key only,
every issue not yet started that lacks an applicable facet or carries a
retired label (a facet's label where the
repository keeps that facet in the tracker's own field), and the started
ones apart. With the user's go-ahead, or when they asked for it, run it
again with `--yes`: it moves each listed issue that is not yet started back
to triage, a comment naming what it lacks posted first, and lists the
started ones without moving them. Where the repository sets
`file_issue.sweep.move: false`, `--yes` instead posts the comment and moves
nothing; an issue already carrying the comment's marker is passed over
without counting against the budget, and `--position <file>` keeps the
read's place in that file, so each run resumes after the last issue the
previous one handled and goes on from the oldest at the end (a missing file starts from the oldest, and so does an unreadable
one, with a warning; a second run on the same file is refused while one
holds it, and so is one whose directory cannot be made or locked; moving keeps no position). It moves (or, without moving,
comments on) at most 50 a run and lists at most 20 pages of 100. Listing pages share one tracker census, bounded to
a minute; the page limit bounds the report, not tracker issue reads. The
next run takes what remains. Offer to settle a
listed issue with [Plan](#plan-an-existing-issue).

Exit `0`: it ran (read every line: what it lists is the result, and a
report without `--yes` may still name a store problem). Exit `1`: a store
that fails closed (not one that only cannot file some issue types) or a
facet with no store kept it from reading anything;
with `--yes`, more than half of the issues that must carry a facet lacking
it kept it from moving any (a store that stopped answering, not a pile of
bad filings, so report it rather than move them by hand); a read failed;
or a refused write stopped it, after which it prints what it moved and
what remains. Exit `2`: a usage error in your command. Add `--json` for
the report as one object.

## Move the facets to another store

**exact** — A move changes where every open issue keeps its type, priority
and size, such as from labels to the tracker's own issue type and fields.
Only a person decides one, so this mode always confirms, whatever the
autonomy level. Run it from the repository's default branch, in a clone
the user keeps until the move is done.

1. **The target.** Write the `issue_tracker.facets` section the
   repository will commit, naming a store for every facet it has
   ([configuration reference](../../CONFIGURATION.md#issue_tracker)), to
   `.context/facet-move/target.yaml` with the Write tool, either as the
   section itself or under `issue_tracker: { facets: … }`.
2. **Preview.** It reads every open issue, writes nothing to the tracker,
   and writes the move record, the section in force now beside the target:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/check-fields.ts" move --target .context/facet-move/target.yaml --record .context/facet-move/record.json
   ```

   Show the user what each issue would get and every **unresolved** issue
   (its source gives a facet no value or two): each is settled in its
   source first, with [Plan](#plan-an-existing-issue). A refusal to start
   names a destination store that cannot be written: the tracker needs the
   field, the issue type or the option it names first, which a person with
   the rights to add it sets up.

3. **Copy**, once the user accepts the preview. It sets each open issue's
   destination from its source and keeps the source:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/check-fields.ts" move --record .context/facet-move/record.json --copy --yes
   ```

4. **Switch.** The user commits the target section to the repository's
   configuration, through a pull request; filings write the new stores
   from its merge on.
5. **Retire**, after the switch. It takes the source off each issue whose
   destination holds its value, copying first where the source changed
   since the copy:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/check-fields.ts" move --record .context/facet-move/record.json --retire --yes
   ```

   Run it again until it exits `0`: an issue whose value it had to copy is
   retired by the next run. A conflict (its source and its destination
   both changed since the copy) and a destination someone cleared are
   left as they are and listed: the user settles each, then runs it again.

Each run writes at most one update per open issue, 30 a minute, and is
resumed by running it again: a stopped run's issues are skipped once done.
Closed issues keep their labels, and no label is deleted. Without `--yes`,
`--copy` and `--retire` print what they would write. To go back, run
`move --restore .context/facet-move/record.json --yes`, which puts back
every value the record says the move changed, where the store still holds
what the move left, and then revert the configuration commit. Keep the
record until the user no longer wants that way back. The record is locked
for each command. Every attempt rechecks the live stores after pacing;
changed issues are conflicts. Remote updates are not atomic with those
reads, so run moves while other writers are idle. Overlapping physical
stores and in-place map changes refuse, as does a move from Jira's required
native priority. Map an unmapped nonempty destination before copying;
restore retains the original label aliases.

Exit `0`: the phase is done for every open issue. Exit `3`: it finished
with something left, each listed by key: an issue for the user to settle,
one the next run finishes, or a phase that refused to start (nothing was
written). Exit `1`: a read failed, or a refused write stopped the run,
which the record shows; run it again once the cause is fixed. Exit `2`: a
usage error, or a record or target it cannot read.

After switching from custom facet labels, keep the former full facets section
in a YAML file and pass `check --yes --retired-from former-facets.yaml` to the
weekly sweep. It resolves retired labels from that section, preserving custom
prefixes and mappings. Without this option it uses the default label stores.
Keep the file while clients may still write the former representation.
