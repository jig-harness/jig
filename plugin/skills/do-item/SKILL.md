---
name: do-item
description: "Pick up one work item from the tracker and carry it to a driven pull request: scout, delegate, review, open the PR, arm the drive."
argument-hint: "[issue-key]"
allowed-tools: "Read Grep Glob Task Bash(bun *) Bash(git *) Bash(gh *) WebFetch AskUserQuestion"
---

# Do Item — start or continue work

Take one issue from the issue tracker and move it forward: on first pickup,
mark it started, gather context, hand the implementation to the right agent,
review the result and open a pull request (PR) the way the repository's
pull-request policy says, then start its review loop; on a later invocation,
continue where the work stands. An issue with
sub-issues (an epic) is worked one sub-issue at a time, and its own status is
kept in step with its children.

Without this skill, each pickup is improvised: status moves are forgotten,
context found by one session is lost to the next, mandatory reviews depend on
someone remembering them, and a finished PR sits unreviewed until a human
notices it.

This is the runnable form of two practices: working an item from the
tracker with its context kept where the next session finds it
([M9 — Tasks & memory](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/README.md)), and opening the pull request under the
repository's policy and handing it to the review loop
([M7 — PR lifecycle & review](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md)).

Jig maintains this procedure and ships it as the `jig` plugin.
Each repository supplies its own values in `.config/jig.yaml`
(see [Consumer configuration](#consumer-configuration)); the repository's own
instructions supply its policy, label taxonomy and validation commands.

The human's page is [README.md](README.md). Run these commands in Bash or
PowerShell with Bun, Git and GitHub CLI available to the command tool. Lead
every TypeScript script command with `bun`, including siblings.
Write generated bodies and JSON through the file-writing tool, then pass their
paths as arguments; no shell utility is needed.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string. Sibling skills are reached
the same way, e.g. `${CLAUDE_SKILL_DIR}/../drive-pr/scripts/drive.ts`.

Run every command from the root of the repository the issue belongs to. Never
`cd` into the skill directory: the scripts find the repository and its
configuration from the working directory.

### How to read the step markers

- **exact** — follow as written; substitute only the documented inputs and
  explicitly supported options.
- **judgment** — the shape shown is illustrative (for example a tool call in
  one harness); use the available equivalent while keeping the required
  fields, guards and data flow.

### Consumer configuration

Every field is optional except `issue_tracker.team` on the Linear adapter (`issue_tracker.adapter: linear`).
The skill reads them at run time from `.config/jig.yaml`:

| Field | What it sets | When absent |
|-------|--------------|-------------|
| `issue_tracker.adapter` | Which tracker adapter the scripts use: `github` for GitHub Issues (the logged-in `gh` command-line client; its settings are under `issue_tracker.github`, [configuration reference](../../CONFIGURATION.md#issue_tracker)) or `linear` (credentials from `LINEAR_API_KEY` or `LINEAR_API_TOKEN`, else a logged-in `linear` command-line client). Jira and a plan file kept in the repository are planned, [ROADMAP item 12](https://github.com/jig-harness/jig/blob/main/ROADMAP.md#12-more-tracker-adapters) | `github` |
| `issue_tracker.team` | Linear only: the team the repository files into, as the prefix its issue keys carry (`ENG` for `ENG-123`) | Required on Linear: the tracker scripts stop with a message naming this field. Not used on GitHub Issues. A file that sets it without naming `issue_tracker.adapter` is refused, since the default adapter has no team: add `adapter: linear` |
| `issue_tracker.states` | Map from canonical state keys to the tracker's own state names | Each key title-cased, e.g. `in_progress` → "In Progress" |
| `issue_tracker.file_command` | How to file a new issue (e.g. a slash command) | Ask the user to file it |
| `issue_tracker.labels` | The repository's label for each role the skill acts on (see the table below) | The default names below |
| `issue_tracker.types` | The repository's work types and the labels that mark each (see [Step 1](#step-1-fetch-the-issue)) | `bug`, `feature`, `improvement`, `task`, `spike`; `bug` marked by `issue_tracker.labels.bug`, the others by `<type>` and `type:<type>` |
| `do_item.work_types` | Fields of the depth table a type overrides | The table's defaults ([configuration reference](../../CONFIGURATION.md#the-depth-table)) |
| `do_item.agents` | Routing from issue to implementing agent (see [Step 4a](#step-4a-standard-start-no-sub-issues)) | Every issue goes to `general-purpose` |
| `routing` | The model tier and effort the implementer runs on, as rules (see [Step 4a](#step-4a-standard-start-no-sub-issues)) | Routes are derived and printed, none applied |
| `do_item.scouts` | Pre-flight [scouts](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) per agent, `{agent: [scouts]}` | No scouts |
| `do_item.gates` | Mandatory review gates, `[{labels, paths, skill}]` | No gates |
| `do_item.execution_plan_block` | Name of the fenced block holding an epic's machine-readable execution plan | `execution-plan-v1` |
| `drive.change_areas_catalog` | Path to the repository's [change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (areas, their agents, validation plan and mandatory review skills) | No catalog: validate with the repository's gate command |
| `repository.base_branch` | The integration branch pull requests land on | The repository's default branch |
| `drive.reviews_drafts` | `false` makes new pull requests open Ready, since the reviewer would not review a draft | Pull requests open as drafts |
| `pull_requests.*` | How pull requests are opened and stacked: `stacking`, `max_stack_depth`, `open_as`, `mark_ready`, `branch_name`, `issue_link`, `size_budget`, `labels`, `title_format` (see [Pull-request policy](#pull-request-policy)) | One pull request per change against the integration branch, branch `{key_lower}-{slug}` (the key as a branch carries it, lowercased: `eng-123`, or `123` for `#123`; then the title as at most 40 lowercase characters), draft, `Closes <KEY>`, marked Ready after the first review round; a human merges |

Every field, its type and its default are in the plugin's
[configuration reference](../../CONFIGURATION.md).

Canonical state keys are `backlog`, `todo`, `in_progress`, `in_review`,
`done`, `canceled`, and optionally `triage`, `ops_pending` and `duplicate`.
This document names states by key; read "`in_progress`" as "the tracker's
name for it from `issue_tracker.states`".

The skill acts on a few labels as process signals, by role:

| Role (`issue_tracker.labels.<role>`) | Default | What it signals |
|---------------------------------------|---------|-----------------|
| `epic` | `epic` | An issue whose sub-issues are worked one at a time |
| `hitl` | `hitl` | A deliverable that is a human's judgment (human-in-the-loop, [HITL](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)); its facets are `<hitl>:<stakeholder>` (`hitl:legal`, `hitl:product`, …) |
| `manual_ops` | `manual-ops` | A step a person performs outside the code |
| `followup` | `pr-followup` | An issue filed from a review finding |
| `bug` | `bug`, `type:bug` | A bug |
| `pattern_prefix` | `pattern:` | A recurring pattern, `<prefix><slug>` |
| `batch_sizes` | `xs`, `small`, `medium` | Sizes the batch check (`/jig:work-batch`) may group |
| `extractable_tails` | `<hitl>:legal`, `<hitl>:tactical`, `<manual_ops>`, `<followup>` | Open sub-issues an epic may hand off instead of finishing |

This document writes each label by its default name; read it as the
repository's label for that role. A list-valued role (`bug`, `batch_sizes`,
`extractable_tails`) is a membership test against the repository's whole
list, never against the default names, which a repository may replace
entirely. `bun "${CLAUDE_SKILL_DIR}/scripts/tracker.ts" labels`
prints the repository's labels, defaults filled in. A repository that does not
use a label never triggers its rule.

### Pull-request policy

**exact** — Never improvise how a pull request is named, based, opened or
sized. `scripts/pr-plan.ts` applies the repository's policy (`pull_requests`
and the facts derived from the repository) and prints what to do:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/pr-plan.ts" branch --issue "<KEY>" --title "<issue title>"
bun "${CLAUDE_SKILL_DIR}/scripts/pr-plan.ts" open --issue "<KEY>" [--stack-on <branch>] [--accept-oversize "<reason>"] [--json]
```

- `branch` prints the branch name for the issue. Create the working branch
  with it from the planned base before the implementing agent writes
  anything. When the harness has already created the working branch and its
  instructions forbid renaming it, keep that branch and say so in the status
  message; the issue-link line in the body still links the pull request.
- `open` prints the plan for the current branch, after validation and the
  pre-PR review gate pass: the `base`, the `gh pr create` arguments the policy
  fixes (`createArgs`: base, `--draft` or not, labels), commands to run after
  creating it (`afterCreate`, such as linking a native stack, with
  `<PR URL>` replaced by the URL `gh pr create` prints), the title convention, the template(s) to fill
  in, the issue-link line, the size against its budget, how it will be
  merged, and warnings. Then open it with exactly those arguments:

  ```bash
  bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh pr create <createArgs...> --title "<title in the planned convention>" --body-file <body.md>
  ```

  Fill the body from the planned template when there is one, put the
  issue-link line in it, and repeat every warning in the status message.
  Then run each `afterCreate` command.

Exit codes of `open`: `0` plan printed; `3` the policy refuses this pull
request, with the reason and the remedy on stderr; `1` the policy or a
repository fact could not be read; `2` usage. On `3`, follow the remedy, never
work around it:

- **Stacking refused** (`pull_requests.stacking: none`, a base that does not
  lead to the integration branch, or a stack deeper than `max_stack_depth`):
  open against the integration branch once the predecessor merges, or
  deliver the dependent change in the same pull request. Never base a pull
  request on another branch by hand.
- **Over `size_budget`**: split the change into pull requests that each fit
  (as a stack when `stacking` allows one, opening each upper layer with
  `--stack-on` the layer below). Only when it genuinely cannot be split,
  re-run with `--accept-oversize "<why>"` and state that reason under
  `## Size` in the body.

`--stack-on <branch>` asks to base the pull request on the head branch of
another open pull request instead of the integration branch (a
[stacked pull request](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)). Use it only
when this change builds on that pull request's unmerged work and the policy
allows stacking. With `stacking: native` the plan's `afterCreate` links the
new pull request into a GitHub stack with the gh-stack extension; with
`branch` it is a plain chain, and the plan warns when merged branches are not
deleted (GitHub then does not retarget the layer above).

### Tracker operations

The scripts reach the tracker through the tracker port in
`${CLAUDE_SKILL_DIR}/scripts/lib/tracker/`, whose adapter the overlay's
`issue_tracker.adapter` selects (`linear` or `github`). Use the script
forms: they work on every adapter and map the workflow states for you. A
harness with a native integration for the same tracker may use it instead;
the native forms are given per adapter: Linear's Model Context Protocol
([MCP](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) tools, and
the `gh` command line for GitHub Issues. Where a later step names only a
Linear tool, the GitHub form is the row of this table it belongs to.

| Operation | Script form | Native: Linear (MCP) | Native: GitHub Issues (`gh`) |
|-----------|-------------|----------------------|------------------------------|
| Get issue (labels, state, parent, children, sub-issue analysis) | `bun "${CLAUDE_SKILL_DIR}/scripts/get_issue.ts" "<KEY>"` | `mcp__linear__get_issue` (no children field) | `gh issue view` with its JSON fields `number`, `title`, `body`, `labels`, `state`, `stateReason`, `url` and, where the `gh` client offers it, `issueType` (no sub-issues field; `issueType.name` is the `nativeType`, `null` when the issue has none or the client lacks the field) |
| List comments | `bun "${CLAUDE_SKILL_DIR}/scripts/list_comments.ts" "<KEY>"` | `mcp__linear__list_comments` | `gh issue view` with the JSON field `comments` |
| List children | `bun "${CLAUDE_SKILL_DIR}/scripts/tracker.ts" children "<KEY>"` | `mcp__linear__list_issues` with a parent filter | `gh api` on the issue's `sub_issues` endpoint |
| Transition state | `bun "${CLAUDE_SKILL_DIR}/scripts/tracker.ts" transition "<KEY>" <canonical-state>` | `mcp__linear__save_issue` with `state: <mapped name>` | The script form: a state is a label or a board option plus open or closed, which only the script maps |
| Post comment | `bun "${CLAUDE_SKILL_DIR}/scripts/tracker.ts" comment "<KEY>" --body-file body.md` | `mcp__linear__save_comment` | `gh issue comment` with the body from a file |
| File a new issue | The consumer's `issue_tracker.file_command` | — | — |

An issue key is `ENG-123` on Linear, where `issue_tracker.team` names the
prefix, and `#123` on GitHub Issues, an issue of the configured repository;
a person may also give a GitHub issue as `123` or as its web address, which
the scripts read as `#123`. This document writes a key as `<KEY>`. Quote it
on a command line (`"<KEY>"`): an unquoted `#` starts a shell comment. A file
or directory named after an issue uses the key's file name: the key itself
on Linear, `issue-123` for `#123`.

### Asking the user

Where this skill says "ask the user", use `AskUserQuestion` under Claude Code
where the session can use it; in any interactive harness where it cannot
(another harness, or a permission mode that denies the tool), ask a
plain-text numbered question and end the turn; under a [headless runner](#headless-runners), raise it through the
runner. With nobody to answer and no runner, stop and state the question.
Never pick on the user's behalf.

## In the delivery loop

- **Upstream**: whatever picks the work — the consumer's planning tooling or
  a human — decides *which* issue to pick up. New issues are filed with
  `issue_tracker.file_command`.
- **Sideways**: a small issue whose change area has siblings may be better
  closed together with them in one PR, by
  [`/jig:work-batch`](../work-batch/SKILL.md). Step 4a checks and
  *suggests*; it never batches silently.
- **Downstream**: this skill opens the PR and arms
  `/jig:drive-pr`, which owns every review round from there.

## Workflow

### Step 1: Fetch the issue

**exact** — `$ARGUMENTS` is the issue key, in any form the scripts accept
([Tracker operations](#tracker-operations)); pass it to them quoted.

**Renamed configuration section.** If the configuration the scripts read has
a top-level `do_issue` section, stop before doing anything else and tell the
user to rename it to `do_item` (its fields are unchanged). That file is
`$JIG_OVERLAY` when it is set, otherwise
`.config/jig.yaml` under `$JIG_CONSUMER_ROOT` (when set)
or the repository root. The old name is not read, so continuing would run
without the repository's routing, scouts and mandatory review gates. The
scripts refuse it with the same instruction, and that refusal is not a
transport failure: never answer it by switching to the native integration
below.

**Launcher context (optional).** A consumer's launcher (for example a script
that opens a workspace straight from the tracker) may pre-fetch the issue and
hand it over, typically as a cache file its instructions name, carrying
`description`, `comments`, `sub_issue_ids` and `linked_issue_ids`. Use it only
when it is fresh: under 30 minutes old, which must survive workspace setup
between launch and agent start. Its comments count as in hand only when it
carries an explicit comments array (`comments_cached: true`); a
description-only context is not "an issue with no comments". Use
`sub_issue_ids` instead of a children fetch when non-empty, and
`linked_issue_ids` as background for scope. Log which context you used. Still
fetch labels, state and parent below: launcher context never carries them.

Fetch the issue with the script form:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/get_issue.ts" "<KEY>"
```

It works for every adapter and also returns `sub_issue_analysis`. If it
stops on the renamed `do_issue` section, stop as above. If it
cannot run here (for example no tracker credential in this environment) and
the harness has a native integration for the tracker, use that instead
(**judgment** — Linear: `mcp__linear__get_issue({ id: <KEY> })`).

Record which one succeeded as `trackerTransport` (`"script"` or `"native"`).
Every later tracker call branches on this recorded value rather than
re-deciding, so a run never calls the script on a host that only has the
native integration, or the reverse.

**If not found**: display the error with the script's suggestions.

**exact** — **Type the item.** Write the issue JSON to `issue.json` with the
file-writing tool (from the native transport: its `title`, its label names
as `labels`, and its own issue type's name as `nativeType`, or `null` when
it reports none), then derive its
[work type](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/determine_type.ts" issue.json
```

It prints `{ type, evidence, depth }`: the type, from the first of a type
label (`issue_tracker.types`), the tracker's own issue type and the title's
Conventional Commits prefix that names one, else `unknown`; which step
decided (`evidence.step`: `label`, `tracker_type`, `title_prefix`, or `none`)
with `evidence.summary`; and the type's row of the
[depth table](../../CONFIGURATION.md#the-depth-table). Put the type and
`evidence.summary` in the status message, e.g.
`Type: bug (label type:bug)`; an `unknown` type is reported the same way.
Exit `1` is a configuration the loading rules refuse: stop the pickup and
report its message. The route (Step 4a item 1) reads the same settings, so
going on would start and assign the item only for the route to refuse it.

### Step 2: Check for prior scout findings

**exact** — Fetch the complete comment context and use the selector result;
do not judge freshness by hand.

Comments are already in hand only when launcher context carried
`comments_cached: true`. Otherwise fetch them on the recorded transport:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/list_comments.ts" "<KEY>"
```

(**judgment** — native, Linear: `mcp__linear__list_comments({ issueId: <KEY> })`.)

Exit `0` prints a JSON array of `{ body, createdAt }`; an empty array is a
legitimate "no comments yet". A non-zero exit means the tracker is
unreachable: treat it as "no findings comment" and take the `run` action
below, rather than blocking on a store nothing can reach.

A long-running issue can carry several **Scout Findings** comments. Choosing
the newest and judging its freshness is a tested script, not hand-run prose:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/select_scout_finding.ts" --input comments.json --git-head
```

Write the comment array verbatim to `comments.json` with the file-writing tool;
`--git-head` reads the current short hash internally. Pass each comment through verbatim; each comment needs `body` plus
whichever of `created_at` or `createdAt` it carries. The script keeps comments
whose body opens with `## Scout Findings` and returns
`{"action", "selectedIndex", "selectedHash", "reason"}`:

| `action` | Means | Do |
|----------|-------|----|
| `reuse` | Same git hash as `--current-hash`, or the selected comment is under 24 hours old | Reuse the findings at `selectedIndex`; skip scouts |
| `rerun` | Different or unreadable hash, and the timestamp is stale (missing, unparsable, in the future, or 24 hours or older) | Re-run scouts; post a fresh findings comment |
| `run` | No findings comment | Run scouts; post one |

Freshness fails closed: a timestamp counts as fresh only when it parses to a
finite, non-negative age under 24 hours.

### Step 3: Choose the path

**exact** — Route solely on whether the issue has sub-issues, whatever its
work type.

- **No sub-issues** → Step 4a.
- **Has sub-issues** → Step 4b.

### Step 3.5: Write the intent-chain snapshot (Refocus)

**exact** — Use the documented mapping and writer.

The intent chain is the short statement of *why* this work exists — the
epic's intent, the issue's scope and acceptance criteria — that
[Refocus](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) puts
back in front of an agent after its context is compacted, and at the top of
every review round. Every invocation, first pickup and resume alike, writes
the issue's snapshot to `.context/intent-chain/`, named by the key's file
name (`ENG-123.md`, `issue-123.md`).

Snapshot publication retries temporary Windows sharing errors. Pickup records
must be regular files: the reader checks the path before opening it and checks
the open file's identity, retaining the no-symlink guard when Unix open flags
are unavailable.

Item snapshots stay keyed by identifier for lookups outside a PR. Interactive
Refocus reads only `.context/refocus-state/<session>.intent-chain.md`, a full
copy atomically refreshed by that session's own pickup. The writer prefers
`CLAUDE_CODE_SESSION_ID`, then `CODEX_THREAD_ID`. A later pickup by another
session cannot replace this copy, even when it overwrites an item alias.
Sessions without a matching copy inject nothing: they never guess from the
branch or the shared `.current`. A fresh session must run pickup before
Refocus can inject its chain. The injection itself is an optional consumer
hook (for example a `refocus.sh` run on session start and on each prompt)
that reads the session copy; the hook may additionally use its payload's
`session_id`.

Each successful write also emits `pickupId`, an immutable, content-addressed
archive of the rendered chain and the identifiers it owns. Keep that token in
the session's task notes and the worktree handoff. Later pickups cannot
overwrite it. Archives unused for 90 days are pruned; a missing token or an
expired archive is a missing source, never permission to guess from an item
alias or `.current`.

After opening the PR, pin this pickup before arming the drive:

```bash
bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/capture-intent-chain.ts" <PR> --pickup <pickupId>
```

Capture verifies the open PR, its head branch and an owned identifier. A later
capture can use the original token even after another pickup; existing valid
pins stay first-write-wins unless explicitly refreshed. If `pickupId` is null
or capture refuses, report the missing chain and triage against the PR and the
linked issue. Never substitute another pickup's token. The budget and
truncation rules live only in `scripts/intent-chain.ts`; the hook and the
drive re-apply its 4,000-character ceiling as a backstop and nothing more.

Build the input from what Step 1 fetched, plus the issue's parent (a second
get-issue call) when it has one:

- **No sub-issues (Step 4a):** `epic` = the parent, `issue` = this issue.
- **Has sub-issues and the `epic` label:** skip the write here. Step 4b writes
  it once a sub-issue is selected, with this issue as `epic` and the selected
  sub-issue as `issue`, so the calibration arm is bucketed by the sub-issue:
  the unit each PR delivers.
- **Has sub-issues, no `epic` label:** `epic` = the parent, `issue` = this
  issue. Step 4b rewrites it with the selected sub-issue added as `subIssue`.

Each entry is `{ identifier, title, updatedAt, description }`, copied verbatim
from the tracker. Use the file-writing tool to serialize the object to
`intent-chain-input.json`, then pass its path:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/intent-chain.ts" --input intent-chain-input.json
```

The script prints `{ path, sessionPath, pickupId, chars, arm, truncated, pointerErrors }`.
`arm` is the Refocus calibration bucket: odd issue numbers are on and even
ones off, unless `JIG_REFOCUS=1|0` overrides it. When the arm is off,
the snapshot is still written but nothing injects it. A non-zero exit never
blocks the work: say in the status message that the snapshot was not written
— or, when `pointerErrors` is non-empty, only partially (the content landed
but an alias or pointer write failed, so a reader may see a stale or missing
chain) — and continue.

A session that gives up the work it picked up (a batch whose every issue
was released, for one) removes its copy, so Refocus stops putting that work
in front of it; item snapshots and pickup archives stay:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/intent-chain.ts" --clear-session
```

It prints `{ sessionPath, removed }`; a missing copy, or no session id, is
already clear. Exit `1` means the copy exists and could not be removed: say
so, since Refocus will keep injecting it.

**When no hooks are loaded** (a harness without a hook system, or hooks not
yet trusted): if the arm is `on`, re-read the writer's `sessionPath` after
every compaction and before each review round, and answer its questions
before your next step. Alongside each read, refresh the copy's retention
clock with `bun "${CLAUDE_SKILL_DIR}/scripts/read-session.ts" <sessionPath>`
(the retention refresh is best effort): the writer
prunes session copies untouched for 14 days, and a plain read does not update
that time. If the copy is missing, or `sessionPath` is null or its write
failed, preserve the tracker context fetched for this invocation in your
handoff rather than reading another session's chain; never replace it with an
identifier-keyed file or `.current`, which are mutable lookup sources. PR
review rounds use the PR pin instead.

### Step 4a: Standard start (no sub-issues)

**judgment** — Scope the implementation, scout patterns and assess review
findings against the issue. The status writes, scripts, templates and gate
routing below remain **exact**.

> **Batch check (issues carrying any label in the repository's
> `batch_sizes` list, by default `xs`, `small` or `medium`).** Review cost is
> largely per PR, so several small closures sharing one review cycle cost
> about what one does, and parallel single-issue PRs over the same files
> become merge conflicts. Run [`/jig:work-batch`](../work-batch/SKILL.md)'s
> proposal for this issue; it reads the tracker and changes nothing:
>
> ```bash
> bun "${CLAUDE_SKILL_DIR}/../work-batch/scripts/candidates.ts" "<KEY>" [--claimed "<KEY>"]
> ```
>
> Pass `--claimed "<KEY>"` when Step 1 shows the issue is already assigned to
> you; otherwise the proposal reads the anchor issue itself as someone
> else's work and refuses it. If it proposes three or more coherent
> siblings, **suggest** the batch, naming the keys, and let the
> human or the prompt decide; a yes hands the issue to `/jig:work-batch`.
> Never batch silently: the human asked for this issue. Skip the check, and
> say so, when the issue carries a sensitivity flag or is **urgent**
> priority: a batch built around it could only proceed by deprioritising the
> very issue you were asked to complete. A refusal from the proposal (exit
> `2`) means no batch: continue alone.

> **Bug pattern pre-scout (bug issues without pattern evidence).** Run only
> if all hold: (a) the issue carries the bug type label; (b) its body has no
> `## Pattern` section, no `pattern:<slug>` label and no "Pattern scout ran"
> line; (c) the bug is generalizable — a class of mistake likely repeated
> elsewhere (a missing authorization or ownership filter, an off-by-one, a
> swallowed error, a missing `await`, an unparameterized query, a hidden
> dependency on the wall clock), not a typo, a single content fix or a
> one-off data regression. Spawn one fast, inexpensive explore scout for
> sibling occurrences of the same class before delegating. Three or fewer
> mechanically identical siblings: add them to the delegation prompt as
> further locations to fix in the same PR. Four or more, or siblings spanning
> several owners or modules: **stop**, post a tracker comment listing them,
> and ask the user whether to (1) expand this issue's scope, (2) file the
> siblings as separate `pattern:<slug>` issues via `issue_tracker.file_command`,
> or (3) fix the single instance and accept the latent debt. Never silently
> fix one instance when the scout shows many: the next agent re-fixes the
> same class. When the scout finds a class and reflection is on
> (`bun "${CLAUDE_SKILL_DIR}/../reflect/scripts/reflect.ts" status`), also
> run [`/jig:reflect`](../reflect/SKILL.md) for what let the class spread (a
> missing gate, lint or instruction), so its recurrence reaches the review.
> Skip the pre-scout, and say so, when the issue is clearly isolated or
> already carries the evidence.

> **Frontmatter pre-flight (documentation changes).** If the repository
> validates documentation frontmatter against a schema and the plan proposes
> frontmatter values (status, tags, lifecycle), check them against that
> schema before delegating. Do not let the implementing agent invent values
> from convention; fix the plan in the issue body first. The repository's
> commit hook may catch it too, but pre-flighting saves a round trip.

1. **exact** — **Determine the agent and scouts**:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/determine_agent.ts" issue.json
   ```

   It reads the issue JSON from Step 1 (a path, or `-` for stdin) and the
   consumer's routing from the overlay:

   - `do_item.agents.default` — the agent when nothing else matches
     (`general-purpose` when `do_item.agents` is absent).
   - `do_item.agents.codearea_areas` — `{label: areaKey}`: an area label
     selects an area in the change-area catalog (`drive.change_areas_catalog`),
     and that area's own `agent` field is the primary signal. A catalog that
     cannot be read, or has an area whose `paths`, `generated` sources,
     `labels` or `tracker` block are malformed or whose globs do not compile,
     is not used (the area's other fields, `agent` included, are not
     checked): routing falls back to the labels below, and the script prints
     `Catalog unavailable, routing by labels only: <reason>` on stderr.
   - `do_item.agents.catalog` — `{catalogAgent: agent}`: maps the catalog's
     `agent` values to agent types.
   - `do_item.agents.labels` — `{label: agent}`: the fallback when no catalog
     area matches.
   - `do_item.agents.title_keywords` — `{keyword: agent}`, optional: a last
     resort matched against the title.
   - `do_item.agents.integrator` — the agent that coordinates when the issue
     routes to more than two agents (default: `do_item.agents.default`). With
     exactly two, the catalog's agent leads, else the first matched.
   - `do_item.scouts` — `{agent: [scouts]}`: the pre-flight scouts for the
     chosen agent.

   For example, a repository might route `agent:backend` to a "Backend Agent"
   whose scouts are a schema scout and a constraint validator. Unless Step 2
   returned `reuse`, spawn the scouts it names once item 2 has started the
   issue.

   **exact** — **Derive the route**, the model tier and effort the
   implementer would run on:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/determine_route.ts" issue.json
   ```

   It prints `{ agent, type, tier, effort, model, runtime_effort, runtime,
   declared, fields, reasons }`: the agent as above, the type's row of
   `routing.types` raised one step each by a flag label, an area's mandatory
   review, a size too large to batch and the `hitl` label, capped at `max`,
   and the tier's family alias for the runtime; `reasons` names the rule
   behind each part ([configuration reference](../../CONFIGURATION.md#routing)).
   Put the tier, the effort, the model and the effort's reasons (its base
   row and every raise in `reasons`) in the status message, e.g.
   `Route: execution, high, sonnet (type bug: medium; flag has-migration raised medium)`.
   The route is not forwarded: the delegation below runs on the model and
   effort it would run on without one, whatever `declared` says. Exit `1` is a
   configuration the loading rules refuse: stop the pickup and report its
   message, which names the field at fault. A refused `routing` section is
   never read as absent; the repository corrects it before the item is
   picked up, which is why the route is derived before item 2 starts it.
   Exit `2` is an `issue.json` that is missing or not an issue: stop the
   pickup and report the input error.

2. **exact** — **Mark the issue started** (if not already active): transition
   it to `in_progress` and assign it to yourself.

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/tracker.ts" transition "<KEY>" in_progress
   ```

   (**judgment** — native, Linear:
   `mcp__linear__save_issue({ id: issue.id, state: "<mapped name>", assignee: "me" })`.)

   Then show the start on Orca's workspace board. In a worktree of
   [Orca](https://www.onorca.dev) this moves the worktree's card to In
   progress; anywhere else it does nothing, and it never fails the step:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/orca-board.ts" in-progress
   ```

3. **exact** — **Persist the findings to the tracker**: post a comment whose
   first line is exactly `## Scout Findings (<hash>)`, where `<hash>` is
   the output of `bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git rev-parse --short HEAD`. That heading is the exact shape
   `select_scout_finding.ts` parses in Step 2; any other wording makes the
   hash unreadable on the next pass. The tracker is the store because the
   findings must survive worktree deletion and be readable by a different
   harness.

   Write the complete findings body with the file-writing tool to
   `scout-findings.md`, starting with `## Scout Findings (<hash>)`. Pass the
   file path so generated text reaches the tracker verbatim:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/tracker.ts" comment "<KEY>" --body-file scout-findings.md
   ```

   (**judgment** — native, Linear: `mcp__linear__save_comment` with the same
   body; it takes the body as a parameter, so no shell is involved.)

   A non-zero exit means the tracker cannot be written right now: proceed
   with delegation anyway. The findings still live in this session for the
   delegation prompt.

4. **judgment** — **Delegate to the agent**: use the harness's subagent
   tool (Claude Code: the Task tool with `subagent_type` set to the
   `primary_agent` that `determine_agent.ts` printed; elsewhere, its own
   subagent tool briefed with that agent's definition, or this session,
   following the same prompt, where there is none). First create the working
   branch named by `bun "${CLAUDE_SKILL_DIR}/scripts/pr-plan.ts" branch` (**exact**; see
   [Pull-request policy](#pull-request-policy)), from the integration branch,
   or from the predecessor's branch when this change builds on an unmerged
   pull request and `pull_requests.stacking` allows it.

   **Review gates — MANDATORY when declared.** Each entry of the overlay's
   `do_item.gates` is `{labels: [...], paths: [...], skill: <name>}`. A gate
   applies when the issue carries one of its `labels`, or the change will
   plausibly touch one of its `paths`. For every applicable gate, end the
   delegation prompt with this directive, verbatim except for the
   substitutions:

   > **Stop after authoring — do not commit and do not open a PR.** Report
   > back (a) every file you created or modified that matches `<paths>` and
   > (b) any other files that depend on those changes. The orchestrator will
   > run `/<skill>` on them before green-lighting the commit. If it returns
   > any `CRITICAL` finding, expect a follow-up to fix it; approval is required
   > before commit.

   When several gates apply, use one combined directive that lists every
   gate's report items and skills in a single final block, so no gate is
   omitted.

   **After the agent returns, the orchestrator must:**

   1. Run each applicable gate's skill over the reported files.
   2. If any returns `REJECT` or `CRITICAL`, loop: send the findings to the same
      agent with "fix and re-report paths", then review again.
   3. Only after every gate approves, commit, run the validation plan and
      open the PR.
   4. If a PR number is already known (for example a re-review after a later
      push), let the gate skill post its result on the PR when it supports
      that.

   **Escape hatch:** if the agent reports no file matching a label-triggered
   gate's `paths` (the label over-applied), the orchestrator may skip that
   gate, but **must** say in its status message "skipping /<skill> because: no
   matching files touched". A silent skip is never acceptable. Gates exist
   because a review rule kept only as convention fails silently every time
   it slips someone's mind; this step turns it into orchestration.

   **Human-in-the-loop (HITL) gate (applies to Step 4a and 4b):**

   Read the issue's flag labels before delegating. If it has a parent, also
   read the parent's current description, for direct pickup and Step 4b
   selection alike, and run `select_execution_issue.ts` on it (see Step 4b):
   its `gates` output may name this issue as a human gate with a reason. Treat
   that as a human checkpoint with the same stop-and-clearance rule as
   `hitl`. If the parent cannot be read, or its Execution Plan section is
   missing its machine-readable block or the block is malformed, do not
   delegate until the gate status can be checked (re-run the planner that
   wrote it, e.g. a plan-epic skill, if the repository has one). A parent
   without any Execution Plan has no plan gate. A plan cannot cancel a live
   `hitl` label.

   `hitl` is a restriction flag. Autonomy is the **default**: every issue
   runs end to end (author → validation → commit → push → PR) unless `hitl`
   or the parent plan's human gate applies. `hitl` exists for issues whose
   deliverable *is* human judgment — spikes, research, root-cause analyses,
   design decisions, plans, customer-facing copy, irreversible cutovers.

   - **Neither `hitl` nor a plan human gate (default)** → proceed end to end
     without pausing. After validation passes, run the **Pre-PR code review
     gate** below, then open the PR as the
     [pull-request policy](#pull-request-policy) plans it (a draft unless
     the policy says Ready). A PR is cheap, and CI feedback is valuable; the
     human still decides what merges. Do **not** ask the user to pre-confirm the PR.
   - **`hitl` or a plan human gate present** → do **not** delegate
     implementation: the issue asks for judgment, not code. Run scouts,
     summarise options, findings and a recommendation in a tracker comment,
     and await explicit direction. If the human asks you to proceed anyway,
     that is clearance: execute end to end on this run. Read the
     `hitl:<stakeholder>` facets when present (for example `product`,
     `technical`, `legal`, `commercial`); otherwise use the plan gate's
     reason to name the responsible stakeholder. If a `hitl` issue carries no
     facet, add the fitting one when you comment. For a `hitl:technical`
     architectural call, use `/jig:decide`, so the escalation
     arrives as a fixed record: options, what would have to
     be true for each, and what would reverse the call.

   This is **orthogonal** to the review gates: those run regardless of
   `hitl`. `hitl` adds a human checkpoint; it never substitutes for an
   automated gate, and its absence never bypasses one. Halting every
   unlabelled issue for clearance would stall a fleet of agents on routine
   work, because labelling lags reality; so agents open PRs by default and
   humans gate *merges*, not *pushes*.

   **Change note — only where the repository has opted in.** Run
   `bun "${CLAUDE_SKILL_DIR}/../changelog/scripts/check.ts" --base <remote>/<base>`
   from the repository root, `<base>` being the branch the pull request
   merges into and `<remote>` the repository's git remote (`repository.remote`,
   else `origin`). It reads the configuration the base holds, not the branch's
   own, so a branch that predates the adoption or drops `changelog.file` is
   still asked. When it prints `not configured`, the repository keeps no
   changelog from change notes: write no note, run nothing else of the
   `changelog` skill, and do not mention a changelog in the pull request.
   Otherwise follow [`/jig:changelog`](../changelog/SKILL.md) § Writing a
   note before the pull request opens: add the branch's note when the change
   is one the changelog's readers would notice or a configured path requires
   one, never edit the changelog or a version file, and run the same check
   with the other gates, so that a finding is fixed before the push. A branch that already
   edited the changelog or the version is converted first
   (`bun "${CLAUDE_SKILL_DIR}/../changelog/scripts/convert.ts" --base <remote>/<base>`,
   the same base as the check, so a stacked branch moves only its own
   edits), and the result reviewed.

   **Pre-PR code review gate (mandatory unless the diff is tiny):**

   Run it after the implementing agent finishes and the validation plan
   passes, **before** `git push` / `gh pr create`. The validation plan is
   the one the change-area catalog emits for the complete workspace change
   when `drive.change_areas_catalog` is declared, and the repository's gate
   command otherwise; do not substitute a fixed command list. `<base>` below
   is the branch the PR will target, as `<remote>/<base>`: the integration
   branch, or the predecessor's branch for a stacked PR (the `base` that
   `bun "${CLAUDE_SKILL_DIR}/scripts/pr-plan.ts" open` prints), and `<remote>`
   the git remote it prints (`remote:`: `repository.remote`, else `origin`).

   **Skip condition — fewer than 20 non-test lines changed (Tiers 1–3 only):**

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/changed-lines.ts" <base>
   ```

   Pass additional excluded git pathspecs after the base to replace the default
   TypeScript test patterns for the repository's languages. If the count
   is under 20 (or zero), skip Tiers 1–3 and log
   `"Pre-PR review skipped: N non-test lines changed (threshold: 20)."` The
   skip does **not** extend to the catalog's `reviewSkills` or the runbook pass
   below: a one-line change can still touch an area with a mandatory
   specialist review.

   **Runbook pass — unconditional when operator documentation changes.** If
   the diff adds or changes any prescribed executable command in operator
   documentation (runbooks) — in a fenced block or inline, with any binary —
   run a dedicated reviewer pass over that runbook and treat its `CRITICAL`
   findings as PR blockers in the **Fix loop** below. Point the reviewer at
   the runbook explicitly: a whole-diff prompt spends its attention on code
   and skims prose. It is mandatory because nothing else reads it — no
   linter, type check or test runs a command written in a Markdown file —
   and the 20-line skip does not apply, since a five-line edit to a
   production step is exactly the change that most needs a reader. Run
   `shellcheck` over the extracted shell blocks and fix what it reports;
   install it first when it is unavailable. Check:

   - **Network calls (`curl`, `wget`, …)**: are the scheme and host checked
     against an allowlist tied to the intended target? A size- and
     time-bounded request can still reach a cloud metadata address or
     another internal host; limits are an additional requirement, never a
     substitute for the host check.
   - **Credentialed commands (`gh`, cloud CLIs)**: does the step rely on
     ambient credentials without stating which identity and scope, and could
     a wrong identity silently succeed against the wrong target?
   - **Destructive commands (`rm`, deletes, anything without undo)**: is the
     target validated (no glob that could match wider than intended), and is
     there a confirmation or dry-run step before the irreversible one?
   - **Any prescribed command**: does variable input reach a shell unquoted,
     including a one-liner assembled from an earlier step's output?

   Apply any infrastructure-specific runbook checklist the repository
   defines in addition, wherever its own trigger matches.

   Regardless of whether Tiers 1–3 were skipped, invoke every skill in the
   catalog's deduplicated `reviewSkills` for the touched areas once, and
   treat a blocking result (`CRITICAL` or `REJECT`) as a PR blocker in the **Fix
   loop**. Reuse an earlier review-gate approval for the same skill only
   while its reviewed files are unchanged; rerun it after any fix touches
   them — a stale approval does not cover the code the PR now ships.

   **Tier 1 — Pattern checks (fast scout):** give a fast, inexpensive model
   the output of `bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git diff "<base>...HEAD"` (non-test files) and the repository's documented
   coding rules (its agent instructions and any machine-readable rules file).
   `CRITICAL` violations **block**: fix before proceeding.

   **Tier 2 — Contract validation (parallel):** run the repository's own
   contract and drift checks for the artifact types present — for example
   database schema drift, generated API specification freshness, hand-written
   type mirrors of a schema, and authorization or data-isolation filters on
   queries. Tier 2 findings are **warnings** (non-blocking; include them
   verbatim in the PR description under `## Review Notes`).

   **Tier 3 — Semantic review:** spawn the strongest available reviewer with
   the full diff, the issue description and acceptance criteria, and the
   relevant framework context. It covers correctness and edge cases,
   security (authorization, data isolation, injection), compliance with the
   repository's architecture decisions and forbidden patterns, the domain
   vocabulary the repository defines, boundary validation, and performance
   red flags. If a review gate already ran on this change, the Tier 3
   reviewer references its result but does not re-run it. Tier 3 `REJECT`
   findings **block** the PR.

   **Verdict summary format** (**exact** — keep the structure; fill the
   values from this run):

   ```
   PRE-PR REVIEW SUMMARY
   ──────────────────────────────────────────────
   Files Reviewed:  <N>
   Non-test lines:  <N>

   Tier 1 (Patterns):  ✅ PASSED | ❌ BLOCKED   (rules checked: N, violations: N)
   Tier 2 (Contracts): ✅ PASSED | ⚠️ WARNINGS  (per-check status)
   Tier 3 (Semantic):  ✅ APPROVED | ❌ REJECTED
   reviewSkills:       ✅ APPROVED | ❌ BLOCKED  (per-skill status; N/A if empty)
   Runbook pass:       ✅ APPROVED | ❌ BLOCKED  (shellcheck: N findings; N/A if no runbook command changed)

   VERDICT: APPROVED | APPROVED WITH WARNINGS | BLOCKED
   Action:  <next step if not APPROVED>
   ```

   **Fix loop — if `BLOCKED` or `REJECTED`:** collect every `CRITICAL` and `REJECTED`
   finding, including blocking `reviewSkills` and runbook results. Spawn the
   same implementing agent type with every finding and the instruction:
   *"Fix all `CRITICAL` and `REJECTED` findings. Warnings do not require fixes —
   they will be noted in the PR body."* When it returns, re-run the complete
   validation plan, then the whole gate again, including every
   `reviewSkills` entry under the reuse rule above. Loop until the verdict is
   `APPROVED` or `APPROVED WITH WARNINGS`.

   - **`APPROVED WITH WARNINGS`**: put the Tier 2 warnings verbatim under
     `## Review Notes` in the PR body, then push.
   - **`APPROVED`**: `bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" --timeout-seconds 3600 -- git push -u <remote> "<branch>"`.

   Then run `bun "${CLAUDE_SKILL_DIR}/scripts/pr-plan.ts" open` and open the PR exactly as it plans
   ([Pull-request policy](#pull-request-policy)). An exit `3` is a policy
   refusal: follow its remedy before opening anything.

   **Pre-push hook failure protocol:** when the repository's pre-push hook
   fails (type check, lint, tests), classify before acting:

   1. **exact** — Run the failing command locally and capture the full error
      list.
   2. **judgment** — Classify each error:
      - **Related**: a file, symbol or test this branch touches
        (`bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git diff --name-only "<base>...HEAD"`), or a consumer of a changed
        export. Fix it.
      - **Unrelated**: a failure already on `<base>`, a flaky test, an
        environment problem (network, missing secret, service not running,
        port in use), or an error in a file this branch did not touch.
   3. **judgment** — If only unrelated errors remain: do not bypass the hook.
      Rebase onto a green `<base>`, repair the shared failure when it is
      safely in scope, or stop and report the blocker. If the failure looks
      systemic (flaky across branches, configuration drift, a missing CI
      step), file a bug with `issue_tracker.file_command`, and, when
      reflection is on, record it with [`/jig:reflect`](../reflect/SKILL.md)
      so the class of failure gets a systematic fix.
   4. **judgment** — If any error is related, fix it.
   5. **judgment** — If you cannot tell, assume related and investigate.

   Repository hooks are mandatory: a failing hook means the branch is not
   ready to push. Never bypass one.

   **Out-of-tree follow-ups — MANDATORY in the status message:**

   When the PR opens, the status message to the user and the tracker comment
   **must** include an `## Out-of-tree follow-ups` section listing every action
   that must happen outside this PR for the change to fully land, for
   example:

   - secrets or configuration to provision in an environment before merge;
   - a manual deployment sync, refresh or rollout after merge;
   - repository settings: a secret, a branch-protection rule, a required
     check;
   - tracker labels, workflows or projects to create;
   - domain-name, content-delivery or edge configuration to apply;
   - cloud resources: database flags, access bindings, keys, buckets;
   - a database migration to run by hand in an environment that does not
     apply it automatically;
   - communications: an announcement, a customer email, a status-page
     update;
   - a follow-up issue to file for a deliberate scope cut.

   If there are none, write
   `## Out-of-tree follow-ups\n\n_None — merging this PR completes the issue._`
   Explicit "none" is required; silence is not. The user should never have
   to ask what else is needed for this to land. If the repository's
   instructions define a machine-readable follow-ups block in the PR body
   (for example one its CI parses into an operations ledger), include it as
   well: mandatory for `manual-ops` issues, with an explicit empty block and
   a stated reason when the label turns out over-applied (then remove the
   label with a comment explaining why).

   **Show the pull request on Orca's board** (exact), as in item 2: in an
   Orca worktree the card moves to In review and links the pull request;
   elsewhere nothing happens.

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/orca-board.ts" in-review --pr <PR>
   ```

   Orca also ships its own Linear skill (`orca-linear`) whose completion
   flow attaches the pull request, posts one comment and moves the ticket.
   This skill already owns the ticket's transitions and comments, so do not
   run that flow as well: it would post a second comment and move the ticket
   twice.

   **Arm the drive (terminal step, immediately after the PR opens):**

   First capture the `pickupId` retained from Step 3.5 with the command
   there, and report any refusal. The driver keeps that pin on re-arm; it
   never discovers a new source from mutable item files.

   The review loop does not start itself. An unarmed PR waits on human
   memory, and most of the loop's calendar time is lost in exactly that
   seam. Arming is part of opening the PR:

   1. **exact** — **Always emit the exact unattended drive command** — in the
      end-of-run status message **and** in the tracker comment that links the PR,
      with the real PR number substituted. Prepare the comment now; post it
      after step 3's arm check so it can report the observed outcome. Use the
      portable `bun` form on **one line** (a `\` continuation is POSIX-shell
      only and breaks on PowerShell and `cmd.exe`):

      ```bash
      bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/drive.ts" <PR> --bots-only -- claude -p "/jig:drive-pr --bots-only <PR>"
      ```

      The pass command (`claude -p "..."`) is Claude Code's, and today it is
      the one documented pass command. Do not guess one for another agent
      tool.

      Include the drive's **observability handles** in the same comment. Take
      the candidate log path from `drive.ts: driver log → ...` in the arm
      output (a `drive.ts: driver log unavailable: <reason>` line instead
      means this driver keeps none: say so and include the reason), or, when the arm was refused, from the refusing driver's
      diagnostics or its row in
      `bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/drives.ts" --json`. A
      per-PR lock refusal always names this PR's own driver; a worktree lock
      refusal can name a different PR, so first confirm the diagnostics'
      `pr` field (or the row's `pr`) equals the PR being armed. A log for a
      different PR is not this PR's handle; do not post it as one. Once
      confirmed, verify the path is a regular file that can be opened for
      append, and include it; otherwise say the driver log is unavailable or
      unverified and include the arm diagnostic. `drive.ts` prints its log
      path before acquiring either lock and writes the log best effort, so
      neither the arm outcome nor the printed path proves the log exists.
      Never post a template such as `<state dir>` as a path. Include the
      fleet commands too: `bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/drives.ts"` lists live drives, and
      `bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/drives.ts" --stop <PR>` stops this one (the process probe uses `ps` on POSIX and
      PowerShell on Windows). These are what a human reaches for when the
      background drive is an agent they have no window into.

   2. **exact** — **Spawn that command in the background** (the harness's
      background execution; do not block the session on it) when **both**
      hold: no uncleared `hitl` checkpoint remains (the issue carries `hitl`
      **and** this run did not receive explicit clearance), **and** the harness
      is Claude Code, whose `claude -p` is today the one documented pass
      command. Spawning
      is then mandatory: an emitted but unspawned command reintroduces the
      human-memory delay this step removes, and a `hitl` issue cleared this
      run is no reason to withhold it. Pass the Bash call's `timeout` of
      `28800000` (8 hours) with `run_in_background`: in an unattended session
      Claude Code stops a background command after 30 minutes without it (10
      in a `claude -p` run whose prompt is passed as text), and
      after 2 hours unless `BASH_MAX_TIMEOUT_MS` is raised (see
      [drive-pr's README](../drive-pr/README.md#the-background-time-limit)).
      Report the task handle. The drive
      works the draft immediately (some review bots review drafts, others
      skip them) and marks the PR Ready at the point
      `pull_requests.mark_ready` declares (after the first completed round
      by default), so
      one human decision is left: the merge. For an uncleared `hitl`
      checkpoint, or another agent tool (Codex, for one), which has no
      documented pass command today, emit the
      command only: starting review rounds would pre-empt the human
      judgment, and a guessed command is worse than one left for a human to
      run.

   3. **exact** — **Never start a second driver; the refusal is mechanical.**
      `drive.ts` holds two single-instance locks for the life of a drive — a
      worktree lock, acquired first, and a per-PR lock, acquired second — and
      either can produce the exit-`11` refusal. The message names which lock,
      its owner, and the diagnostics the claim carries: the PR that owner is
      driving, its worktree and its log. Only a claim written by an older
      driver is pid/hostname-only (see
      `${CLAUDE_SKILL_DIR}/../drive-pr/references/terminal-states.md`
      § The single-instance locks). Check the spawned task's output **once**,
      a few seconds after issuing it — not immediately, and not in a poll
      loop:
      - Exit `11` on the **per-PR** lock → this PR is already being driven:
        report "a drive is already live on #<PR>" with the holder's details;
        do not retry and do not kill the other driver.
      - Exit `11` on the **worktree** lock → read the diagnostics. The same
        PR means already armed (report as above); a different PR means this
        worktree is busy with other work (report the conflict; do not retry
        or kill). Only when the claim predates diagnostics is the case
        **ambiguous**: because the worktree lock comes first, a re-invocation
        for this same PR from the same worktree also fails here. Report the
        ambiguity itself, with the holder's pid and hostname (`drives.ts`
        lists what that owner's other lock says), and let a human resolve
        it. The step-1 command, posted right after this step, is the durable
        handle for whoever does.
      - Any other **non-zero** exit → a failed arm, not a running one:
        report it with the exit code and captured output.
      - Exit `0` → the drive already reached a terminal state within the
        window: report its outcome rather than assuming it is running.
      - Still running → armed; move on without further polling.

      Post the prepared tracker comment with the arm outcome and the
      observability handles. Report the log path's verified, unavailable or
      unverified status independently of the arm outcome.

   **Post-merge status rule (Step 4a and 4b):** when the PR merges to the
   integration branch, transition the issue to `done` — unless a manual,
   operational or legal step remains (an operator checklist, a drill, a
   verification, a sign-off), in which case transition it to `ops_pending`.
   Nothing else moves statuses; deployment state comes from git, not from the
   tracker. An issue that itself carries the configured epic label (an epic
   with no sub-issues, worked whole in Step 4a) reaches `done` only with the
   closing authorization in Step 5a; without one, transition it to
   `in_review` and report that it waits for an accepting verdict or a waiver.

   **`manual-ops` — surface the operator checklist and park in `ops_pending`,
   not `done` (Step 4a and 4b):** when the issue carries `manual-ops`, the
   orchestrator must:

   1. **exact** — Extract the operator checklist from the issue body: a
      section titled "Operator Checklist" or "Manual Steps", or any
      explicitly enumerated out-of-band step.
   2. **exact** — Include every item verbatim, as unchecked Markdown
      checkboxes, in the PR's `## Out-of-tree follow-ups` section and the
      closing tracker comment.
   3. **exact** — On merge, transition the issue to `ops_pending` (not
      `done`, and not left in `in_review`: the code is merged, so what
      remains is human-owed work) and comment "PR merged → Ops Pending —
      awaiting manual ops: [list the steps]." Do not advance to `done` until
      every step is recorded as complete. If the tracker has no
      `ops_pending` state, hold in `in_review` instead.
   4. If the body has no checklist, comment: "This issue carries
      `manual-ops` but has no operator checklist. Please add the steps to the
      issue body before this can close." Never silently advance to `done`.

   `manual-ops` exists because CI and deployment automation do **not** perform
   these steps. A merge that silently advances to `done` leaves production
   half-wired; parking makes the board honest about what remains.

### Step 4b: Progress through sub-issues

**judgment** — Evaluate live dependency and merge evidence, and preserve the
human's choice when several candidates are eligible; the selector and
snapshot mapping are **exact**.

1. **exact** — **Check whether everything is complete**:
   - `sub_issue_analysis.all_complete` → Step 5a.
   - Otherwise, if every remaining incomplete sub-issue carries a label in
     the repository's `extractable_tails` list (by default `hitl:legal`,
     `hitl:tactical`, `manual-ops` and `pr-followup`; `bun "${CLAUDE_SKILL_DIR}/scripts/tracker.ts" labels`
     prints the list in effect) → also Step 5a, which re-verifies eligibility under
     the extract-and-close rule before acting. Otherwise an epic whose only
     open work is a tail would pick that tail and work it as ordinary code.

   `sub_issue_analysis` comes from `get_issue.ts`. On the native transport
   (Linear's `get_issue` has no children field), build the same facts from a
   children listing first.

2. **exact** — **Read the Execution Plan from the parent description** (if
   present). A planner (e.g. a plan-epic skill, if the repository has one)
   writes a `## Execution Plan` section whose machine-readable content is the
   fenced JSON block named by `do_item.execution_plan_block` (default
   `execution-plan-v1`). The Markdown around it is for humans; never parse
   its steps, blockers or overrides as machine facts.

   Write the selection object to `selection-input.json` through the file-writing
   tool and pass its path:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/select_execution_issue.ts" --input selection-input.json
   ```

   The input is `{ description, epic, live, mergedConflictEdges }`:
   `description` is the parent description and `epic` its key; `live` maps
   every child and predecessor key to `{ state, blockedBy }`, where `state` is
   the tracker's state **type** (`triage`, `backlog`, `unstarted`, `started`,
   `completed`, `canceled`) and `blockedBy` the live blocker keys. Fetch these
   live, paging every relation listing and keeping `blocks` predecessors;
   do not treat an `unknown` state type from a summary listing as live
   evidence. (**judgment** — Linear adapter example: on the CLI, `linear api`
   GraphQL `issue { identifier state { type } inverseRelations { nodes { type
   issue { identifier state { type } } } pageInfo { hasNextPage endCursor } } }`;
   on MCP, read relation state explicitly rather than assuming `get_issue`
   includes blockers.) A failed read stays absent, which makes its candidates
   ineligible. Start `mergedConflictEdges` empty; it holds only `from>to`
   pairs whose delivering PR has been verified below.

   The selector prints `{ present, eligible, gates, mergeConflicts }`.

   **Decision logic:**

   a. A missing block inside an existing Execution Plan, a duplicate or
      malformed block, or a plan for a different epic is an error: stop and
      name re-running the planner as the repair. There is no prose fallback.
   b. Verify each `mergeConflicts` edge's delivering PR against its recorded
      `conflictFiles`. Find the PRs in the predecessor's description and
      comments; check issue reference, scope and changed files with
      `bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh pr view "<URL>" --json "body,files,baseRefName,mergedAt"`. Require it
      to target the integration branch and have `mergedAt` set. A merged PR
      for earlier work on the same issue does not clear a later open one.
      Ambiguous or unreadable evidence keeps the pair out; `ops_pending`,
      `todo` or the absence of a tracker blocker alone proves nothing.
      Re-run the selector with the verified pairs.
   c. `eligible` lists incomplete, eligible issues in band order, each
      checked against its own plan predecessors and live blockers. Bands are
      precedence depth, never whole-group barriers. Honour human checkpoints
      from `gates` and live `hitl` labels before delegating.
   d. If several issues are eligible, ask the user to choose. If none are,
      report the blockers and the missing evidence.
   e. Only when no Execution Plan exists at all (`present: false`), fall
      back to `sub_issue_analysis.next_issue`.

   **Epic-level snapshot fallback.** Whenever this issue carries the `epic`
   label and this invocation ends without reaching item 3 with a selected
   child — item 1 routing to Step 5a, every candidate ineligible, a pause for
   the user's choice, or any other return without a `nextSubIssue` — rewrite
   the intent-chain snapshot before returning: pass this issue as **both**
   `epic` and `issue` (the identical object), no `subIssue`, no parent fetch.
   This issue *is* the epic, so its own intent line, acceptance criteria and
   scope must fill the epic slots; mapping its parent there would show an
   empty or unrelated intent. Passing it again as `issue` is deliberate: the
   issue-scope section has a protected floor under truncation that the epic
   scope lacks, so this is the only way the epic's scope is guaranteed to
   survive. (Acceptance criteria get no such protection in either slot.)
   Step 3.5 skipped its write because item 3 was expected to cover it;
   leaving both unwritten would present whatever an earlier child selection
   wrote as current.

   Let this write compute its arm normally from the epic's identifier. Do
   not try to preserve a child's arm or work around a `JIG_REFOCUS`
   override: the arm is a pure function of the identifier, so the next
   selected child re-derives its own arm when item 3 (or Step 3.5) writes
   for it. This fallback's arm only governs injection while no child is
   selected.

3. **exact** — **Fetch the selected sub-issue in full, then rewrite the
   intent-chain snapshot** per Step 3.5's split. `nextSubIssue` (from
   `sub_issue_analysis.next_issue`, or chosen in the second step above) may
   carry only key, title and state — a children listing does not include
   descriptions — so building the snapshot from it would lose the
   sub-issue's scope. Fetch
   it with get-issue first. Then: **if this issue carries `epic`**, pass the
   fetched sub-issue as `issue` and this issue as `epic` (the arm is
   bucketed by `issue`, and the epic's intent is read from `epic`);
   **otherwise**, keep this issue as `issue` and pass the fetched sub-issue
   as `subIssue`. Do this on every selection, including a move straight
   from a just-completed sub-issue to the next, so the snapshot always names
   the sub-issue actually being worked.

4. **exact** — **Derive the sub-issue's route**: write the fetched
   sub-issue to `issue.json` and run `determine_route.ts` on it as Step 4a
   item 1 does, reporting its route and stopping on exit `1` or `2` the same way,
   before item 5 starts it. The route derived for this issue in Step 4a is
   this issue's, never the sub-issue's.

5. **exact** — **Start the selected sub-issue**: transition it to
   `in_progress` and assign it to yourself, as in Step 4a item 2.

6. **judgment** — **Delegate** as in Step 4a. When the selected
   sub-issue builds on a sibling whose pull request is still open, the
   pull-request policy decides what happens: with `pull_requests.stacking:
   none` (the default), do not start it on top of that branch; wait for the
   sibling to merge, or ask the user to choose another eligible sub-issue.
   With `native` or `branch`, branch from the sibling's head branch and open
   with `bun "${CLAUDE_SKILL_DIR}/scripts/pr-plan.ts" open --stack-on <that branch>`.

### Step 5a: All sub-issues complete

**exact** — Refresh every child, then obey the reconciler's verdict and the
acceptance and `manual-ops` guards. The pseudocode below shows the required
data flow, not an executable harness API.

> **Parent status guard.** Never advance a parent beyond what its sub-issues
> warrant: it reflects the *least-advanced* sub-issue. Among started states
> the ladder is `in_progress` < `in_review` < `ops_pending`; `done` is
> completed.
>
> | Condition | Parent status |
> |-----------|---------------|
> | Every sub-issue is `done`, or `canceled`/`duplicate` (abandoned, never completing) | `done` — capped at `ops_pending` if the **parent itself** carries `manual-ops` |
> | Every sub-issue is merged-and-parked (`done`, `ops_pending`, `in_review`) or abandoned | The least advanced of those (any sub-issue in `in_review` → `in_review`; otherwise `ops_pending`) |
> | Any sub-issue still in progress, to do or blocked | Keep `in_progress`; continue with Step 4b |
>
> `reconcile_parent_status.ts` implements and tests this table; do not
> re-derive it by hand.

> **Extract-and-close rule (an epic is done on its designed scope, not on a
> child count of zero).** When an epic's code work is merged and every
> remaining open child is a tail the epic was never scoped to finish — one
> carrying a label in the repository's `extractable_tails` list (by default a
> `hitl:legal` sign-off, `manual-ops` or `hitl:tactical` operations work, or
> `pr-followup` review debt) — extract each (link it back to the epic,
> comment on it naming the epic it came from, then remove it from the epic and
> move it to the repository's standing destination for that kind of work, if
> it has one) and close the epic. This requires the epic's closing
> authorization (defined below): "every child is closed or extractable" is not
> itself the authorization, because sub-issues marked done whose code never
> landed are a recurring failure. A waiver stands in for a review nobody ran;
> it never overrides a rejecting verdict. If the repository has a tool that performs
> the check, move, link and close, run it rather than doing the moves by
> hand.

1. **exact** — **Re-fetch every sub-issue's current state** — never rely on
   stale data — and feed it to `reconcile_parent_status.ts`, which owns the
   decision. A script cannot issue a harness's native tool calls, so fetching
   (and, on the native transport, paginating) stays here; only the decision
   moves out. Branch on Step 1's `trackerTransport`, normalize the result to
   the script's transport-neutral `ReconcileInput`, and fail closed on every
   gap:

   ```typescript
   let listing // ReconcileInput — see reconcile_parent_status.ts
   if (trackerTransport === "native") {
     // Adapter example: Linear MCP. Any rejected call or unreadable response
     // routes to the same fail-closed `truncated` shape.
     try {
       const parent = mcp__linear__get_issue({ id: issue.id })
       const fields = ["status", "statusType", "labels"]
       // A missing or non-array `issues` reads like an empty page; if that
       // page also said `hasNextPage: false` the listing would look complete.
       const requireIssuesArray = (p) => {
         if (!Array.isArray(p.issues)) throw new Error("Unreadable child listing")
         return p
       }
       let page = requireIssuesArray(mcp__linear__list_issues({ parentId: issue.id, limit: 250, fields }))
       const children = [...page.issues]
       // Loop only on an explicit `true`, and only while each cursor is new:
       // any repeated cursor (an echo, or a cycle A → B → A) means stuck.
       const seenCursors = new Set()
       let paginationStuck = false
       while (page.hasNextPage === true) {
         const cursor = page.cursor
         if (cursor === undefined || seenCursors.has(cursor)) { paginationStuck = true; break }
         seenCursors.add(cursor)
         page = requireIssuesArray(mcp__linear__list_issues({ parentId: issue.id, limit: 250, cursor, fields }))
         children.push(...page.issues)
       }
       // Complete only on an explicit final `hasNextPage === false`, no stuck
       // cursor, and a real labels array on the parent: a missing `labels` is
       // a partial fetch, and defaulting it to [] would hide `manual-ops`.
       const complete = !paginationStuck && page.hasNextPage === false && parent.labels !== undefined
       listing = complete
         ? {
             found: true,
             parentLabels: parent.labels,
             children: children.map(s => ({ state: { name: s.status, type: s.statusType }, labels: s.labels })),
           }
         : { found: true, truncated: true, parentLabels: [], children: [] }
     } catch (err) {
       listing = { found: true, truncated: true, parentLabels: [], children: [] }
     }
   } else {
     // Script transport. A failed command, non-JSON stdout, or a literal
     // `null` are all a failed listing, never a crash.
     let parent
     try {
       parent = JSON.parse(run(`bun "${CLAUDE_SKILL_DIR}/scripts/get_issue.ts" "${issue.identifier}"`))
     } catch (err) {
       parent = { found: false }
     }
     // `found: true` alone does not prove the response is for THIS issue:
     // reconciling another epic's children and writing the result here would
     // corrupt an unrelated issue's status.
     if (parent?.found !== true || parent.identifier !== issue.identifier) {
       listing = { found: false, parentLabels: [], children: [] }
     } else {
       // The parent's children listing carries no per-child labels, so every
       // tail label would read as absent. Re-fetch EVERY child — completed
       // and abandoned too, since a reopened child's stale terminal state
       // must not go undetected.
       //
       // PHASE A — an agent action, not a script. For every child whose key
       // matches /^(?:[A-Za-z][A-Za-z0-9]*-\d+|#[1-9]\d*)$/ (defense in depth before it
       // reaches a command line), issue `bun "${CLAUDE_SKILL_DIR}/scripts/get_issue.ts" "<key>"` as its OWN command-tool
       // call, all in the SAME turn (parallel tool calls), never one at a
       // time: each call may take up to 30 seconds. Build `childFetchResults`,
       // a Map from the REQUESTED key to the parsed stdout; omit any call that
       // exited non-zero or printed non-JSON.
       //
       // PHASE B — verify, then merge. A child's state is trustworthy only
       // from a fetch that succeeded AND answered for that exact key.
       const allChildren = [
         ...(parent.sub_issue_analysis?.completed_issues ?? []),
         ...(parent.sub_issue_analysis?.abandoned_issues ?? []),
         ...(parent.sub_issue_analysis?.incomplete_issues ?? []),
       ]
       // `get_issue.ts` reports an unreadable state as type `unknown` with a
       // name of `Unknown` or blank; no real workflow state looks like that.
       const isUnreadableState = (s) =>
         s?.type === 'unknown' && (s?.name === 'Unknown' || !s?.name?.trim())
       const verifiedChildren = allChildren.map((c) => {
         const fetched = childFetchResults.get(c.identifier)
         if (fetched?.found !== true || fetched.identifier !== c.identifier || isUnreadableState(fetched.state)) {
           return null
         }
         return { ...c, labels: fetched.labels, state: fetched.state ?? c.state }
       })
       // One unverified child makes the whole listing untrustworthy: its
       // stale state alone could advance the parent wrongly.
       listing = verifiedChildren.some((c) => c === null)
         ? { found: true, truncated: true, parentLabels: [], children: [] }
         : { found: true, parentLabels: parent.labels, children: verifiedChildren }
     }
   }
   ```

   Write `listing` as `reconcile-input.json` through the file-writing tool;
   pass that file to the reconciler and parse its stdout as
   `decision`:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/reconcile_parent_status.ts" --input reconcile-input.json
   ```

2. **exact** — **Act on `decision.verdict`**. `decision.parentState` is the
   canonical state to transition the parent to (`done`, `in_review`,
   `ops_pending`, `in_progress`), and `decision.parentStateName` the
   tracker's name for it. The reconciler reads the repository's state names
   and labels (`issue_tracker.states`, `issue_tracker.labels`), so a child in
   the tracker's own review state counts as parked whatever it is called.

   | `verdict` | Action |
   |-----------|--------|
   | `listing_failed` | **Stop**: report that the tracker refresh failed or was incomplete; do not change the parent's status |
   | `keep_in_progress` | Go to Step 4b |
   | `extract_and_close_eligible` | Verify the epic's closing authorization (below); if it has one, extract and close per the rule above (see the `manual-ops` note below when the parent carries that label). Otherwise **stop**: report that every remaining sub-issue is an extractable tail but the epic has no accepting verdict or waiver yet |
   | `set_status` | When `decision.parentState` is `done` and the parent is an epic (`listing.parentLabels` carries the configured epic label), verify its closing authorization (below) first; without one, transition it to `in_review` instead and report that it waits for an accepting verdict or a waiver. Transition the parent: `bun "${CLAUDE_SKILL_DIR}/scripts/tracker.ts" transition "<KEY>" <canonical-state>` on the script transport; Linear native: `mcp__linear__save_issue({ id: issue.id, state: <mapped name> })` |

   **Closing authorization.** An epic may close only when its newest verdict
   from the repository's epic acceptance review accepts it, or when a person
   has recorded a waiver on it and its newest verdict, if there is one, is not
   a rejection. An accepting verdict that a later rejection superseded does
   not count, and a waiver never overrides a rejection. A count of done
   children is never the authorization, whichever verdict above produced it.

   **`manual-ops` guard on parent completion.** When `decision.parentState`
   is `ops_pending` because the parent itself carries `manual-ops` (every
   sub-issue is done, but the parent cannot close until its operator
   checklist is acknowledged), comment with every unchecked item from the
   parent's `## Operator Checklist` as unchecked checkboxes: "All sub-issues
   are Done — PR merged → Ops Pending. Waiting for manual ops: [list the
   steps]." If there is no such section, comment: "Parent carries
   `manual-ops` but has no Operator Checklist. Add the steps to the issue
   body before this can close." Never silently advance it to `done`. Without
   an `ops_pending` state, cap at `in_review`.

   **`manual-ops` guard on `extract_and_close_eligible`.** A parent carrying
   `manual-ops` can never reach `done`, only `ops_pending`. Check
   `listing.parentLabels` before acting: if `manual-ops` is present, extract
   the tails but do not close the epic (a sweep tool's "no close" mode, if it
   has one). Then explicitly transition the parent to `ops_pending` (or
   `in_review` without that state) and post the operator-checklist comment
   above. Leaving the epic at its old status (e.g. still `in_progress`) after
   its tails moved would violate the status rule. `decision.reason` states
   this distinction when it applies.

3. **exact** — **Display completion.** Name abandoned children explicitly
   rather than folding them into "complete": a reader must tell "X shipped"
   from "X shipped, Y cancelled" at a glance. The denominator is the
   eligible count (`total - abandoned`), matching `progress_percent`.

   ```markdown
   ## 🎉 All Sub-Issues Complete!

   **Issue**: [<KEY>](<issue URL>)
   **Progress**: {completed}/{total - abandoned} complete ✅ ({progress_percent}%)
   **Abandoned**: {abandoned} cancelled/duplicate (excluded from the count above)  <!-- omit when abandoned is 0 -->

   **Next**: Create PR if code changes exist
   ```

## Headless runners

A consumer may run this skill unattended inside its own runner. That
runner's integration replaces each point where this skill asks the user (the
Step 4b choice, an ambiguous requirement, a `hitl` clarification, the
pre-push "cannot tell" branch) with its own escalation channel, and may
report the milestones the skill already passes (issue fetched, plan ready,
delegated, pre-PR review, PR opened). Payloads sent to a runner carry
references (paths, commit hashes, PR and issue links), never file contents.
Without such a runner, ask as in [Asking the user](#asking-the-user).

## Error handling

| Error | Solution |
|-------|----------|
| Issue not found | Check the key against the tracker's form ([Tracker operations](#tracker-operations)); list the tracker's issues (Linear: `linear issue list --team <issue_tracker.team>`; GitHub Issues: `gh issue list` on the configured repository) |
| Tracker unreachable on one transport | Use the other transport recorded in Step 1 |
| Missing tracker credential | Set the adapter's credential (Linear: `LINEAR_API_KEY` or `LINEAR_API_TOKEN`, or log in to the `linear` command-line client; GitHub Issues: sign in with `gh auth login`, and add the `project` scope with `gh auth refresh` when the states are on a board), or use the harness's native integration |

## Scripts reference

| Script | Purpose | Input | Output |
|--------|---------|-------|--------|
| `get_issue.ts` | Fetch an issue | Issue key | JSON with details and sub-issue analysis |
| `list_comments.ts` | Fetch an issue's comments | Issue key | JSON array of `{ body, createdAt }` |
| `tracker.ts` | Tracker operations: `children`, `transition`, `comment`, and the configured `states` and `labels` | Operation, issue key, and a canonical state or a body from `--body-file` (stdin also supported) | Operation result |
| `determine_type.ts` | Derive an issue's work type and its depth-table row | Issue JSON (path or `-`) | JSON `{ type, evidence, depth }` |
| `determine_agent.ts` | Route an issue to an agent and its scouts | Issue JSON (path or `-`) | JSON with agent and scouts |
| `determine_route.ts` | Derive the implementer's route: agent, model tier, effort, the runtime's model, and the reasons | Issue JSON (path or `-`) | JSON `{ agent, type, tier, effort, model, runtime_effort, runtime, declared, fields, reasons }` |
| `select_scout_finding.ts` | Pick the newest Scout Findings comment and judge freshness | Comments JSON (`--input` or stdin), `--git-head` or `--current-hash` | JSON decision (`reuse`/`rerun`/`run`) |
| `select_execution_issue.ts` | Read an epic's Execution Plan and list eligible sub-issues | Selection JSON (`--input` or stdin) | JSON `{ present, eligible, gates, mergeConflicts }` |
| `reconcile_parent_status.ts` | Decide a parent's status from its sub-issues | `ReconcileInput` JSON (`--input` or stdin) | JSON decision (`verdict`, `parentState`, `parentStateName`, `reason`) |
| `pr-plan.ts` | Apply the pull-request policy: a branch name, or the plan for opening the current branch's PR | `branch --issue "<KEY>" --title <title>`, or `open [--issue "<KEY>"] [--stack-on <branch>] [--accept-oversize <reason>]` | Branch name, or the plan (text or `--json`); exit `3` when the policy refuses |
| `intent-chain.ts` | Write the Refocus intent-chain snapshot (Step 3.5); `--clear-session` removes this session's copy | `IntentChainInput` JSON (stdin or `--input`); nothing with `--clear-session` | Snapshot files and a JSON summary (`path`, `sessionPath`, `pickupId`, `chars`, `arm`, `truncated`, `pointerErrors`); with `--clear-session`, `{ sessionPath, removed }` |
