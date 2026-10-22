---
name: work-batch
description: "Batch several small, independent tracker issues from one area into one pull request with one commit each, driven once; holds back sensitivity-flagged issues. After the merge, closes out every issue in the batch."
argument-hint: "<area | path | issue-key> [--budget N] [--limit N] | after-merge <PR>"
allowed-tools: "Read Grep Glob Edit Write Task Bash(bun *) Bash(git *) Bash(gh *) AskUserQuestion"
---

# Work batch: one pull request, several small closures

Most of the cost of a pull request (PR) is its review: the rounds of
comments, the fixes, the waits for continuous integration
([CI](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)). That cost is paid per pull request,
not per line, so a team that opens one pull request per small issue pays it
again for each, and several single-issue pull requests over the same files
turn into merge conflicts. This skill groups several small, independent
issues from one area of the code into one
[batch](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): one pull
request, one commit per issue, one drive through review.

It owns the proposal (which issues may join, ranked and fitted to a budget),
the claim, the batch's commit and pull-request conventions, and the steps
after the merge for every issue the batch closes. It delegates the rest:
validation and the pre-PR review to the repository's plan and `do-item`'s
gate, the review rounds to [`/jig:drive-pr`](../drive-pr/SKILL.md). The human
page is [README.md](README.md); the policy and its reasons are in
[`references/batch-policy.md`](references/batch-policy.md).

### Paths and working directory

`${CLAUDE_SKILL_DIR}` below stands for the absolute path of the directory
containing this `SKILL.md`. Claude Code fills it in. In any other harness,
replace it with that path yourself before running a command: a shell would
expand the unset variable to an empty string. Sibling skills are reached the
same way, e.g. `${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts`.

Run every command from the root of the repository the issues belong to.
Never `cd` into the skill directory: the scripts find the repository and its
configuration from the working directory.

### Configuration

The skill reads `.config/jig.yaml` through the plugin's configuration reader.
Its own section is `work_batch` (`point_budget`, `size_points`, `max_items`,
`solo_flags`, `sizes`, `ranking`); every field, its default and the other
fields it reads (the label roles, the repository, type and context labels,
`do_item.agents.codearea_areas`, `drive.change_areas_catalog`) are in the
plugin's [configuration reference](../../CONFIGURATION.md#work_batch). To
read one value yourself, run
`bun "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/jig-config.ts" <field>`.

### Asking the user

Where a step needs a person's answer (a verdict in step 2, an issue left
for a person to settle), use `AskUserQuestion` under Claude Code where the
session can use it; in any interactive harness where it cannot (another
harness, or a permission mode that denies the tool), ask a plain-text
numbered question and end the turn. With nobody to answer, stop and state the question. Never pick on the
user's behalf.

## When not to batch

Work the issue alone with [`/jig:do-item`](../do-item/SKILL.md) when:

- **It carries a solo-only flag**, making it a
  [solo-only issue](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):
  the human-in-the-loop label and its facets, the manual-operations label,
  every flag an area of the change-area catalog carries (a database-migration
  flag, an interface-contract flag), and `work_batch.solo_flags`. Each starts a review
  gate or a human step that applies to the whole pull request: in a batch
  that gate would run over unrelated changes, or every issue would wait for
  the one human. `candidates.ts` holds these back itself, and no setting
  removes one.
- **The anchor area carries such a flag itself.** Every change there carries
  it, so no batch is possible; the script refuses the anchor.
- **It is urgent.** A batch shares its slowest issue's fate. `candidates.ts`
  holds it back, and refuses it as the anchor, an urgent epic included.
- **It is larger than the batchable sizes**, or turns out to be.

## Workflow

### 1. Propose

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/candidates.ts" "<anchor>" [--budget N] [--limit N] [--claimed "KEY,KEY"] [--format json]
```

`<anchor>` is one of:

| Anchor | Pool |
|--------|------|
| A change-area name | Open issues carrying a label that names the area (`do_item.agents.codearea_areas`) and a batchable size label |
| A path in the repository | The same, for each area whose own `paths` match the path |
| An epic's key | The epic's open children |
| One issue's key | Open issues sharing its area-naming label; the issue is kept first. An issue that may not join a batch itself ends the run with a recommendation to work it alone |

An issue key is `ENG-123` on Linear and `#123` on GitHub Issues, an issue of
the configured repository; this document writes it as `<KEY>`. Quote a key,
and an anchor, on a command line: an unquoted `#` starts a shell comment.

The batch is filled in rank order to a point budget (each size costs points)
and an item limit, whichever binds first, skipping an issue that does not fit
rather than stopping at it. `--budget` and `--limit` override
`work_batch.point_budget` and `work_batch.max_items` for one run.

**Anchoring on an issue already started and assigned to you?** Add
`--claimed "<its key>"`. Without it the script reads the issue's own state and
assignee as someone else's work and refuses it as the anchor.

Read all three lists the script prints:

- **Proposed batch**: each issue's size, points and score, its revalidation
  line (below) and, under each issue of the most expensive batchable size
  (`medium` by default), a verdict prompt for step 2.
- **Held back**: each issue that may not join, with its reason. A reason
  that names a label to add (no size, no type, no repository or context label,
  a context or area label the configuration does not know) is a labelling gap: fix the label and re-run.
  The solo-only rows must stay held back.
- **Labelling gaps**: issues matching the anchor that carry no size label at
  all, so the pool read never returned them. Size them and re-run: the
  re-run decides whether they are batchable. `[also: …]` names a blocker
  their labels already show; a bare row means no known blocker, not
  batchable. An epic anchor has no such list: a child with no size is held
  back instead.

A `WARNING` line means part of the picture is missing (a gap read that
failed, labels that came back truncated, a seed over budget); say so in your
status message.

### 2. Check the proposal as a batch

Read each proposed issue in full first: its description and its comments
(`bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/get_issue.ts" "<KEY>"` and
`bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/list_comments.ts" "<KEY>"`). A proposal carries titles and labels only. Then
confirm what the script cannot:

- **The issues are independent.** Two whose fixes touch the same function
  are one issue: merge them in the tracker or drop one.
- **None is larger than its size label says.** A size label is an estimate;
  drop one you doubt.
- **One area is preferred.** An epic anchor may span two; a mixed batch takes
  the union of both areas' validation and mandatory reviews. Split unless
  the anchor is why the areas mix.
- **Each issue under a verdict prompt gets an explicit verdict:** re-size it
  (fix the label, then re-run so the budget prices it), keep it in the batch,
  or leave it for its own pull request.

The constraints and why: [`references/batch-policy.md`](references/batch-policy.md).

### 3. Claim

**exact** — Just before claiming, re-run step 1's command and compare each
issue's revalidation line with the first run's. The line prints these
fields: `state`, `assignee`, `priority`, `size`, `type`, `repo`, `context`,
with ids in angle brackets.
Compare the ids, not the names: a state or a person can be renamed, and two
can share a name. Drop every issue whose line changed, that left the
proposal, or that the re-run now holds back: a priority raised to urgent
holds the issue back, and a changed assignee means someone else took it.

Record, for each issue you keep, its state and assignee ids from that line:
the release in step 4 restores them. Then, for each:

1. Move it to `in_progress` and assign it to yourself, as `/jig:do-item`
   Step 4a item 1 does:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" transition "<KEY>" in_progress
   ```

   (**judgment** — the assignee through the harness's tracker tool, the one
   that saves an issue's state and assignee: the mapped state name, assignee
   "me".)

2. Comment on it, naming the anchor and every other issue in the batch, so a
   second agent sees it is spoken for and by which batch
   (`bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" comment "<KEY>" --body-file body.md`).
   Once the last issue is commented on, remove the file
   (`bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git clean -f -- body.md`):
   a file left in the worktree keeps the drive from converging.

Then write the batch form of the
[intent chain](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), as `/jig:do-item`
[Step 3.5](../do-item/SKILL.md#step-35-write-the-intent-chain-snapshot-refocus)
describes, with `"mode":"batch"`, the anchor as `issue` (for an area or path
anchor, the highest-ranked issue), the anchor's parent as `epic` when it has
one, and every claimed issue in `items`. Write that JSON to `batch-intent.json`
with the file-writing tool:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/intent-chain.ts" --input batch-intent.json
bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git clean -f -- batch-intent.json
```

Run the second command only after the first exits `0`; it removes the input
file so the worktree stays clean. Keep the `pickupId` the first prints: the pull request is captured with it in step 5.

### 4. Implement, one commit per issue

Name the branch with the pull-request policy, after the highest-priority
issue in the batch. The `branch` operation of `pr-plan.ts` only prints the
name; create the
branch from the planned base and switch to it before the first commit:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/pr-plan.ts" branch --issue "<highest-priority KEY>" --title "<that issue's title>"
bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git switch -c <printed-branch-name> origin/<base>
```

When a branch of that name already exists for this batch, switch to it
rather than creating a second one. When the harness has already created the
working branch and its instructions forbid renaming it, keep that branch and
say so, as `/jig:do-item` does. Never commit the batch on the integration
branch or on another task's branch.

For each issue, in rank order: read it in full again if step 2 was long ago;
when it is a bug that can recur elsewhere and carries no pattern evidence,
run the same sibling scout `/jig:do-item` Step 4a runs for a single bug
(three or fewer mechanically identical siblings go into this issue's commit;
more become their own issues); implement it; run the repository's validation
plan on what is staged for it; then commit it alone:

```
fix(<scope>): <what this issue changed> (<KEY>)

Refs: <KEY>
```

One commit per issue is what keeps the batch reviewable and lets one issue
be reverted without the others.

**After implementing, check the size again.** The `open` operation of
`pr-plan.ts` (step 5)
measures the diff against `pull_requests.size_budget`, and step 2's reading
may have grown an issue. When the batch has grown past its budget, trim it in
this order:

1. **Take out** the lowest-ranked issues and their commits (revert those commits, or
   an interactive rebase on the unpushed branch). Unassigning an issue alone
   would leave its diff in the pull request.
2. **Release** each issue taken out. Read it again first. If its state and
   assignee ids are still the ones the claim set, move it back to the state
   recorded at the claim (`bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" transition "<KEY>" <canonical-state>`;
   `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" states` maps a name to its canonical key) and restore the
   recorded assignee. If someone changed either since the claim, leave that
   change in place and name the issue in your report for a person to settle.
   Either way, comment on it that it left the batch and why.
3. **Stop if nothing remains.** Undo everything step 3 wrote: the issues are
   released by substep 2; remove this session's intent-chain copy, so
   [Refocus](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) stops putting released issues in front of you, and drop the
   `pickupId`:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/intent-chain.ts" --clear-session
   ```

   Write no replacement chain (a batch chain with no issues is not valid),
   open no pull request, return the branch to the commit it started from,
   and report the released issues.
4. **Re-anchor.** The chain's `issue` is rendered apart from `items`: when
   the anchor was released, the highest-ranked remaining issue becomes the
   anchor.
5. **Rewrite the intent chain** for the remaining issues, as in step 3, and
   keep the new `pickupId`: the pull request is captured with it, so the
   drive is never pointed at a released issue.
6. **Comment** on every issue still in the batch, naming the batch as it now
   stands, so no batch comment names an issue the pull request will not
   close.

### 5. Validate, review and open one pull request

Run the validation plan over the whole batch diff, then `/jig:do-item`'s
pre-PR code review gate (Step 4a) once over the union, with every mandatory
review gate any issue's labels or paths name. Then plan the pull request:

```bash
bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/pr-plan.ts" open --issue "<highest-priority KEY>" [--json]
```

Follow the plan as `/jig:do-item`'s
[pull-request policy](../do-item/SKILL.md#pull-request-policy) says,
including its refusals (exit `3` over `size_budget` means trim, step 4).
The body carries the plan's template and a table with one row per issue:
the issue-link line the plan prints, in its form, for that row's key
(`Closes <KEY>` by default), the issue's commits and what changed:

```markdown
## Batch

Anchor: `billing` (change area). 4 issues, 9 of 16 points.

| Issue | Commits | What changed |
|-------|---------|--------------|
| Closes <KEY> | `a1b2c3d` | Rounded the invoice total once, at the end |
| Closes <KEY> | `d4e5f6a` | Named the missing currency in the error |
| Closes <KEY> | `b7c8d9e` | Paged the refund list |
| Closes <KEY> | `f0e1d2c` | Removed the unused export |
```

A row per issue is what closes each issue on merge: an issue named only in
prose stays open. Add the `## Out-of-tree follow-ups` section `/jig:do-item`
requires, for every issue.

### 6. Drive it once

Capture the intent chain with the `pickupId` from step 3 (or step 4's
rewrite), then arm the drive exactly as `/jig:do-item`'s "Arm the drive"
(Step 4a) says: emit the command, spawn it under Claude Code, never a second
driver, and post the tracker comment with the arm outcome on every issue in
the batch. One drive covers every issue.

```bash
bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/capture-intent-chain.ts" <PR> --pickup <pickupId>
bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/drive.ts" <PR> --bots-only -- claude -p "/jig:drive-pr --bots-only <PR>"
```

## After the merge

When the batch pull request merges, run `/jig:work-batch after-merge <PR>`.
The batch's own table is the checklist: every `Closes` row gets the steps a
single issue gets after its pull request merges, not only the first.

1. **List the rows**: `bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- gh pr view <PR> --json "body,mergeCommit,mergedAt"`
   and take every issue key in the table's issue-link cells.
2. **For each row**:
   - **Status**: `/jig:do-item`'s post-merge status rule decides: `done`,
     or `ops_pending` when a manual, operational or legal step remains
     (always so for an issue carrying the manual-operations label).
   - **Closing comment**: the merge commit, and the pull request's
     `## Out-of-tree follow-ups` items for that issue as unchecked boxes.
   - **Labels**: compare the issue's labels with the catalog's
     `tracker.labels` and `tracker.flags` for the areas the issue's commits
     touch. A flag the catalog derives that the issue lacks is a gap to
     report (and to settle, if it obliged a step the batch did not take);
     add a missing area label.
3. **Each parent once**: for every distinct parent of the closed issues,
   after its children's statuses moved, run `/jig:do-item`
   [Step 5a](../do-item/SKILL.md#step-5a-all-sub-issues-complete)'s
   reconciliation (`reconcile_parent_status.ts`) and act on its decision.
4. **The deferred findings**: every `deferred` outcome in the review
   rounds should have become a follow-up issue (the follow-up label). Re-list
   the review threads, resolved and unresolved, and the reviewer's summary
   findings, since a deferred thread resolves the moment its reply posts and
   a summary finding has no thread; check the tracker item behind each
   deferral exists.
5. **Record the close/open ratio**: the issues the batch closed against the
   new follow-up issues its review rounds filed. Comment it on the anchor
   issue (an issue or epic anchor); for an area or path anchor, on the
   highest-priority issue the batch closed:

   ```
   Batch close/open: <PR> closed <n> issues and filed <m> follow-ups (<n>:<m>).
   ```

   That ratio is the evidence that batching closes small issues faster than
   review creates them, not only that it feels faster.

## The eligibility mode

Tools that judge many issues at once (a dashboard panel ranking possible
batches, a planning view marking issues batchable) ask the script instead of
keeping their own copy of the rules:

```bash
bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" --stdin-file issues.json -- bun "${CLAUDE_SKILL_DIR}/scripts/candidates.ts" --eligibility [--claimed "KEY,KEY"] [--catalog <path>]
```

It reads no tracker. **Input**: a JSON array of issues in the tracker
interface's pool form (`PoolIssue` in
`${CLAUDE_SKILL_DIR}/../do-item/scripts/lib/tracker/port.ts`), every field
required: `identifier`, `title`, `url` (or `null`), `priority` (0 none, 1
urgent to 4 low), `createdAt`, `state` `{ id, name, type }`, `assignee`
`{ id, name }` or `null`, `labels`, `hasOpenChildren`, and `truncated` (the
lists the read could not take in full; `[]` when complete). An omitted field
is refused, never defaulted: a missing `truncated` would read a partial label
list as complete.

**Output**: one JSON document.

```json
{
  "version": 1,
  "policy": {
    "batchSizes": ["xs", "small", "medium"],
    "sizes": ["xs", "small", "medium", "large", "xl"],
    "sizePoints": { "xs": 1, "small": 2, "medium": 6 },
    "pointBudget": 16,
    "maxItems": 6,
    "soloFlags": ["hitl", "manual-ops", "<every catalog flag>", "<work_batch.solo_flags>"],
    "soloFlagPrefixes": ["hitl:"],
    "epicLabel": "epic",
    "followupLabel": "pr-followup",
    "repoLabel": "web",
    "repoLabels": ["web", "api"],
    "typeLabels": ["bug", "feature"],
    "contextPrefixes": ["area:"],
    "areaLabelPrefixes": ["area:"],
    "areaFlags": { "billing-api": ["api-review"] },
    "stateNames": { "backlog": "backlog", "in progress": "in_progress", "done": "done" },
    "knownAreaLabels": ["area:billing"],
    "knownContextLabels": ["area:billing", "domain:payments"],
    "knownSizes": ["xs", "small", "medium", "large", "xl"],
    "ranking": { "sizes": { "xs": 2, "small": 1, "medium": 0 }, "provenance": 3, "sharedAreaLabel": 1 }
  },
  "verdicts": [
    { "identifier": "ENG-1", "eligible": true, "size": "small", "points": 2, "reason": null, "message": null },
    { "identifier": "ENG-2", "eligible": false, "size": null, "points": null,
      "reason": { "kind": "solo-flag", "flag": "hitl" }, "message": "solo-only: carries `hitl`" }
  ]
}
```

`verdicts` is in input order, one per issue, decided by the same
`excludeReason` the proposal uses. `reason.kind` is one of `truncated`,
`solo-flag`, `solo-area`, `urgent`, `conflicting-size-labels`,
`not-batchable-size`, `conflicting-repo-labels`, `wrong-repo`, `conflicting-type-labels`,
`no-type-label`, `no-context-label`, `unknown-context-label`,
`unknown-area-label`,
`has-open-children`, `unknown-state`, `already-closed`, `already-assigned`,
`already-started`; `message` is the reason as a person reads it.
`areaFlags` maps each catalog area that carries a flag to its flags: an
issue whose area-naming label names one is `solo-area`. `stateNames` maps
each `issue_tracker.states` name, lower case, to its canonical state; it
decides a state whose `type` is empty or not one the tracker interface
names, and a state it does not name either is `unknown-state`. A `null` `repoLabel`,
`typeLabels` or `contextPrefixes` means the repository configures none, and
that check is off. `knownContextLabels` are the labels the configuration
already names (the area-naming labels, `do_item.agents.labels`, the
catalog's labels); an issue whose every context label is outside it is held
back. `knownSizes` is `work_batch.sizes`, else the batchable sizes and
`review.taxonomy.sizes`: without `work_batch.sizes`, a size label named in
neither (a `large` the repository never lists) is not recognised as a size.

**Version**: `version` changes when a field is removed or changes meaning;
adding a field, or a new `reason.kind`, keeps it. A reader refuses a version
it does not know, and treats an unknown `reason.kind` as not eligible. The
proposal's `--format json` output carries the same `version`.

## Scripts reference

| Script | Purpose | Exit codes |
|--------|---------|------------|
| `bun "${CLAUDE_SKILL_DIR}/scripts/candidates.ts" "<anchor>"` | Resolve the anchor, read its pool through the tracker interface, print the proposal (`--format table` or `json`) | `0` printed (possibly empty); `2` usage or an anchor that cannot be batched, with the reason and what to do instead; `1` configuration, catalog or tracker error |
| `bun "${CLAUDE_SKILL_DIR}/scripts/candidates.ts" --eligibility` | Verdicts for issues on stdin, no tracker read | `0` printed; `2` usage or unreadable input; `1` configuration or catalog error |

## In the delivery loop

- **Beside `/jig:do-item`**: the batched form of picking up work. `do-item`'s
  batch check runs this skill's proposal for a small issue and *suggests* a
  batch when it finds coherent siblings; it never batches silently.
- **Downstream**: opens the pull request and arms `/jig:drive-pr`, as a
  single pickup does.
- **`/jig:resolve-review-comments`**: its deferred findings carry the
  follow-up label, which ranks *up* here: already-owed, already-scoped work
  is the densest source of batchable issues.
