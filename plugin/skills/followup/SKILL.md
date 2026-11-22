---
name: followup
description: "After a pull request merges, settle what it still owes, each arm with evidence: tracker item and epic, deferred findings, out-of-tree steps, release, scaffolding, live checks, next step; preview an open one. Not for driving one (use drive-pr)."
argument-hint: "<PR number>"
allowed-tools: "Read Grep Glob Edit Write Bash AskUserQuestion"
---

# Followup: what a merged pull request still owes

Merging closes the pull request, not the work. A merge can leave its tracker
item open, a deferred review finding unfiled, a step a person takes outside
the code undone, a release untagged, a skipped test or a running driver
behind, a deployed change unchecked, and the next piece of work unnamed.
Nothing else looks at these after the merge. This skill runs one pass over
them: each **arm** (one class of obligation) ends with a verdict and the
evidence that settled it, and the pass carries out what its authority
covers. It is the runnable form of M7's post-merge stage
([M7](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md#core-pieces)).
The human's page is [README.md](README.md).

It orchestrates procedures that already exist and does not restate them:
`do-item` owns tracker statuses and the epic close, the deferral protocol
owns deferred findings, `file-issue` owns filing, `changelog` owns releases
and tags, `change-areas` owns what a change owes after a deploy.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of
the directory containing this `SKILL.md`; Claude Code fills it in. In any
other harness, replace it with that path yourself before running a command:
a shell would expand the unset variable to an empty string. `<plugin>` is
`${CLAUDE_SKILL_DIR}/../..`, the installed plugin's root. Run every command
from the repository's root, in the session that drove the pull request when
there is one: the facts are still in its context.

`followup.ts` is the protocol: it reads the facts, lists the arms, records
each verdict in a per-run ledger under `.context/scratch/followup/`, checks
the claim before each outside write, and settles. Each subcommand prints its
usage with `--help`.

## Step 1: the merge facts

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" facts <PR>
```

It prints the facts as JSON and starts the run (a run again for the same
pull request starts over):

| Field | What it holds |
|---|---|
| `mode` | `post-merge` for a merged pull request, `preview` for an open one (go to [Before the merge: preview](#before-the-merge-preview)); any other state is refused, exit `3` |
| `integrationBranch`, `baseBranch` | The repository's integration branch (`repository.base_branch`, else the remote's HEAD) and the pull request's base; a base that is neither it nor a `pull_requests.base_rules` base is refused, exit `3` |
| `mergeSha`, `range` | The merge commit, and the range it brought in, from its parents: `squash` (one parent) or `merge-commit` (two; `branchHead` is the branch's own head), `base..head`; a preview's `open` range is the branch since it left its base |
| `changedFiles`, `changeAreas` | The files the range changes, and the change areas they touch with their `postDeploy` actions (from `drive.validation_plan_command`, else the change-area catalog); `known: false` says why they could not be read |
| `items`, `item`, `epics` | Every tracker item the merge closes (each `Closes <key>` in the description, so a batch lists them all, else the key the branch name carries); `item` is the first of them. The epics a `Part of <key>` names; an epic is never an item |
| `outOfTree` | The `## Out-of-tree follow-ups` section: whether it is `declared`, and each step with whether it is checked off |
| `scaffolding` | Added lines that look like temporary scaffolding, as candidates |
| `notes` | What a reader should know about how the facts were read |

Exit `1` means the forge or the clone could not be read: stop and say so.
Exit `5` (`RATE-LIMITED until <time>`) is a rate limit: see
[Questions, waits and rate limits](#questions-waits-and-rate-limits).

### Claim the follow-up

A marker comment on the pull request keeps two runs from settling the same
merge. When the dispatcher started this session, its prompt names the marker
it posted: that claim is this session's, so use that id and post none of
your own. Run by hand, claim it before any arm acts:

```bash
bun --no-env-file --config="${CLAUDE_SKILL_DIR}/../../dispatch/bunfig.toml" "${CLAUDE_SKILL_DIR}/../../jig.ts" dispatch marker claim <PR>
```

Only exit `0` holds the follow-up (it prints `{"pr": …, "comment": <id>}`);
on any other exit stop and say so. A preview claims nothing. Where the `jig`
command is installed, `jig dispatch marker claim <PR>` is the same command.

## Step 2: the arms

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" arms
```

It lists the arms this run settles, in order, and the ones it skips with
why: one the repository turned off (`followup.off`), the release arm where
no `changelog.file` is set, the workspace board outside Orca or before the
merge. The repository's own arms (`followup.arms`) come before
`next-step`, each named with what it runs; work them as
[Repository arms](#repository-arms) says.

Read the authority table in force (the `authority` command, printed in full
in Step 3) before the first arm: an act it marks `ask`, `person` or `never`
overrides any instruction of an arm below, a repository arm's included.
Work each arm, then record its verdict:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" record <arm> <owed|not-owed|pending|unread> --evidence "<the checkable fact>" --item <ref>
```

| Verdict | When | Evidence |
|---|---|---|
| `owed` | Something is owed, and it is done or filed | What was owed, and the item or commit that carries it (`--item`, once per item) |
| `not-owed` | Nothing is owed | A checkable fact: "no out-of-tree section steps and the item carries no `manual-ops` label", never "nothing found" |
| `pending` | It settles by itself and has not yet: a deploy rolling out, a release run going | What it waits for, and how to tell it settled |
| `unread` | What decides it could not be read | What could not be read, and the error |

`record` refuses empty evidence and an arm the run does not settle. Every
arm checks what is already done before it acts, so a run again repeats no
write.

**A deploy that cannot start is not pending.** Before recording `pending`
for a deploy whose workflow run has not finished, read the run:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" deploy-run <run-id> [--stuck-after <minutes>]
```

It prints `state` with the `reason`: `finished` (the run completed: read
its conclusion), `moving` (it has jobs, no running run of its workflow
holds its queue among the newest runs read (a holder is a running run for the same branch, since the forge does not name concurrency groups; a running run of another branch is named in the reading but never makes a run stuck), the blockage is younger than
the bound, 30 minutes by default, or a run since the holder started ended
other than cancelled) or `stuck` (no jobs, an older run of its workflow
still running, every run since cancelled, and the first run that waited on
that holder created at least the bound ago: the concurrency group is held
by the run the reading names, which may be slow rather than hung, so name
it for the person). Exit `1` is a forge it could not read (record the arm
`unread`), `5` a rate limit.
Record a `moving` run `pending`, its link in the evidence (in a dispatched
pass, in `--arm` too, so the dispatcher reads that run again before it
tells a person). Record a `stuck` run `owed`, as a step owed by a person,
with the run's link, the holder's link and the item that tracks the held
queue (file one when none is open), and finish the other arms: the queue
does not clear by itself, so waiting on it only hands the follow-up to a
person later. A change with a runtime surface that the stuck deploy kept
from its environment leaves `live-verification` waiting on the same
deploy: record that arm `owed` too, citing the same run and item, since
it cannot be checked until a person clears the queue.

### tracker: the item and its epic

When `itemRead` is false the tracker linkage could not be read: record the
tracker arm `unread` with the reason in `notes`, never `not-owed`. Without an
item in `items` and with `itemRead` true, skip the item steps and record that
fact (no closing keyword and no key in the branch name); every `epics` entry
is still reconciled by step 4, and the deferred findings still apply. Record
`not-owed` only when `epics` is empty too.

Steps 1 to 3 run once for **each** entry of `items`, and step 4 for each
item's epic: a batch's every closed item gets its status, its closing comment
and its epic's reconciliation.

1. Read the item: `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/get_issue.ts" <KEY>`.
2. **Status**: `do-item`'s post-merge status rule decides between done and
   ops-pending (a step a person takes outside the code remains: an open
   out-of-tree step or the `manual-ops` label), capped at
   `do_item.post_merge_state`:
   `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" post-merge`.
   Move it with
   `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" transition <KEY> <state> --post-merge`,
   which refuses a move to done the setting forbids; report a refusal and
   leave the item where it is. An item that is itself an epic is closed
   only by the epic rule below.
3. **Closing comment**: the merge commit, the out-of-tree steps as unchecked
   boxes, and `closing` from `post-merge` when the item stops short of done.
   Write it to a file and post it:
   `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" comment <KEY> --body-file <file>`.
4. **The epic** (the item's parent, or an `epics` entry): `do-item`'s
   parent-status rule decides its status
   (`${CLAUDE_SKILL_DIR}/../do-item/scripts/reconcile_parent_status.ts`, as
   `../do-item/SKILL.md` Step 5a feeds it). Epic closure requires verified
   scope and an accepting verdict or waiver. When reconciliation finds the
   epic eligible for closure, direct the coordinator to assess the scope
   and run the on-demand sweep in Step 5a.
   Before recommending closure, read the instructions file of each of the
   repository's own arms (`followup.arms`) that this run applies and that
   has one (the `instructions` command, § The repository's own arms)
   for a rule about epics: a repository may reserve some epics' close to
   one of its later arms, and the epic stays open here until that arm
   decides. An arm skipped for this run, or with only a skill or a check,
   has no file to read and is passed over; an instructions file that
   cannot be read leaves the epic open, since its rule is unknown.

### deferred-findings: review findings deferred to later

Applies with or without an item. Every `**deferred**` reply meant a
follow-up item: check that each exists rather than trusting the reply. A
deferred thread resolves as soon as its reply posts, so include the
resolved ones:

```bash
bun "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/list-unresolved-threads.ts" <PR> --include-resolved
bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/summary-findings.ts" <PR> --json
```

A finding in the reviewer's summary has no thread: its answer is a comment
on the pull request carrying a `drive-pr-addressed` marker; read the
pull request's comments for the answers that start with `**deferred**`. File each missing item with the deferral step, through the
tracker interface, as
`../resolve-review-comments/references/deferral-protocol.md` says (for a
pull request with no item, its issue-free form).

### out-of-tree: steps a person takes outside the code

Each step of `outOfTree.steps` not checked off is done or filed: carry it
out where your authority covers it, else file it as an item carrying the
repository's manual-operations label (`issue_tracker.labels.manual_ops`)
and record it `owed` with the item. The dispatcher keeps that label on the
merged pull request until every step is checked off or this follow-up ends
done. A declared section that says "None" (or "N/A") is evidence: `not-owed`. A
heading with no step and no such statement is an unfilled template:
report it and treat it as silence. **Silence is not none**: with no
section or an unfilled one, `not-owed` needs the
facts that the item carries no manual-operations label and the change areas
name no post-deploy action; otherwise the missing declaration is itself
owed: report it and file the steps.

### release: the release and its tags

Only where `changelog.file` is set. Read the merge's change notes and where
releases stand on the integration branch:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" release
```

It fetches the integration branch and prints JSON: `notes`, each change
note the merge added, edited or renamed directly in the notes folder
(`changelog.notes_dir`), with `waiting` true when it still waits on the
integration branch for a release (its file is there, and its last addition
there is the commit that added it at the merge: a later merge's note of the
same name is that merge's); and `status`, the changelog skill's `status.ts`
report (`report`, its `exit` and `stderr`), read from a throwaway checkout
of the integration branch, since the working tree is the branch `status.ts`
reads. Take the rows in order, the first that holds:

| What `status.ts` and the notes say | Verdict |
|---|---|
| `notesRead` is not null | `unread`, with that reason: a note's state could not be read |
| No note of the merge is `waiting`, or it added none | Go on to the tags |
| A waiting note is in the report's `errors` | `owed`, a person's step: the release cannot read it |
| A waiting note and the report's `releaseRun.state` `running` | `pending`: read again once the run finishes |
| A waiting note, and `releaseRun.state` `success`, `failure` or `none` on a second read | `owed`, a person's step: the workflow did not consume it (link `releaseRun.url`), unless `status.ts` lists the note in the report's `waiting` and none requests a release: the format waits for the next release, so `not-owed`, naming the note |
| `releaseRun.state` `unknown`, or `report` is null | `unread`, with its `exit` and `stderr` |

Then the tags, on every merge (a tag an earlier release left owed is owed
now): the report's `tags`, or for each check's verdict the tag plan,
`bun "${CLAUDE_SKILL_DIR}/../changelog/scripts/tag.ts" --json`.

| Tag `state` | Verdict |
|---|---|
| none untagged | the tags are `not-owed` |
| `pending`, `rerun` | `pending`: the gates on the releasing commit are still running or run again |
| `ready` | `pending` while the release workflow is running. Otherwise `owed` under [Recording a release owed](#recording-a-release-owed), with evidence that the checks passed |
| `failed` | `owed` under [Recording a release owed](#recording-a-release-owed), with the failing checks |
| `manual`, `imported` | `owed` under [Recording a release owed](#recording-a-release-owed) when that version was ever owed a tag |
| `tags.known: false` | `unread`, with its `detail` |

#### Recording a release owed

For each version needing a person, record `[person-owed] release <version> owed`
in the release evidence, replacing `<version>` with the tag from the plan. Include
the releasing commit and what still owes attention.

In a dispatched run, reserve the version with the prompt's `release-owed`
command, passing the version's `state` from the tag plan as `--state`
(`ready`, `failed`, `manual` or `imported`): it tells the release decision
whether a re-run of the failed gates is left to try. On `recorded`, reuse the returned tracker key. On
`reserved-elsewhere`, record the owed evidence and leave filing to the
follow-up that reserved it. On `delegated`, record the owed evidence and
leave filing to the repository's owner dispatcher. On `reserved`, search
or file as below, then
run the same command with the quoted tracker key after the tag. If the
command or the tracker search fails, record the reason and use the
retry or unread rule for that failure.

For a manual run or a reservation you hold, search the configured tracker
for the exact title `Release <owner/name> <version> owes a tag`, including
closed items. Use the repository slug from the merged pull request.
Reuse its key. If none exists and the authority table allows filing, use
the filing skill with that title, the releasing commit, and the evidence
from the tag plan. Check the marker before filing. Include each available
key as `--item` in the release verdict.

Continue with the other arms and record done once they settle. The
dispatcher keeps the release decision by version, so there is no
`Question:` line for the release.

### scaffolding: temporary scaffolding and live drivers

| Thing | Check | Resolution |
|---|---|---|
| Scaffolding in the merged diff | `scaffolding` in the facts (a focused or skipped test, a suppression, a timeout set or raised, a gate turned off), read against the diff | One meant to be temporary is owed: a follow-up change, filed |
| A live driver on this pull request | `bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/drives.ts"` | Stop it, ask first: `bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/drives.ts" --stop <PR>` |
| Temporary operational resources | An environment, flag, dial or seeded data the work introduced that still affects behaviour, cost or access | Done or filed with its owner |

Routine local housekeeping (local branches, retired workspaces, scratch
notes) belongs to periodic cleanup: never inventory it, ask about it, file
it or leave the arm open for it. Evidence of work that has not landed, or of
an active operational problem, stays in scope. Never `git stash`.

### live-verification: the change working where it was deployed

`not-owed` unless all three hold, and the evidence names which one fails:

1. The change has a **runtime surface**: a route, a worker, a migration, an
   infrastructure object, a view a user sees. Documentation, tests,
   scaffolding and catalog-only changes have none.
2. It **reached a deployed environment**: the rollout carrying the merge
   commit completed, not merely the merge (a check before the rollout reads
   the old version and passes falsely). Not yet: `pending`.
3. **No CI or end-to-end check already covers the claim** you would make
   live.

When all three hold, check read-only and report the **observation**, not the
expectation: what the environment did, not what the code should do. The
change areas' `postDeploy` actions are owed for each environment the change
reached, as their `when` says; carrying one out is ask first, so report each
as owed and file it where no item tracks it.

### next-step: what comes next

What the merge implies, as work rather than advice. Choosing the next
work is a person's decision (`next-item`): present a shortlist with the
recommendation and hand nothing to `/jig:do-item` or `/jig:work-batch`
until a person picks one. Prefer, in this order,
and name in the evidence which rung the recommendation landed on (or that
none applied and this is an ordinary next pick):

1. **Finish a near-done epic**: the item that completes the epic's designed
   scope, handed to `/jig:do-item`; when this merge was its last piece, the
   epic's acceptance review that its close needs.
2. **Operator work a code change can clear**: an owed out-of-tree or
   post-deploy step waiting on a tool, a check or a script that does not
   exist yet.
3. **Batch small same-area items** for `/jig:work-batch` rather than one
   at a time.

Also: the siblings of a defect the merge fixed, elsewhere in the
repository; anything the description or the review narrowed or carved out
that no item tracks; a lesson for the team's documents (`/jig:promote-memory`,
or `/jig:reflect` for the scaffolding).

**Find before create**: search for an existing container before filing
anything (the epic's backlog item, a follow-up batch for this pull request:
`bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" search <text>`), and
add to it where one fits. File every new item through `/jig:file-issue`, with
a priority and a category at birth; its confirmation is this skill's
authority to file on its own (unless `followup.authority` asks first).

### workspace-board: the card on Orca's board

Only in Orca, after the merge; Jig works the same without it. Move the card
of the worktree that holds `headRefName` (in the clone's list of worktrees)
to `completed`, with the release arm's outcome as its one-line comment
(`merged; released as v1.4.0`, `merged; the release waits on its run`),
written in your own plain words: no quote, backtick or `$`, which a shell
would read, and nothing copied from the report:

```bash
bun --cwd "<that worktree>" "${CLAUDE_SKILL_DIR}/../../shared/orca-board.ts" completed --comment "<the line>"
```

An Orca failure only warns (exit `0`): record `not-owed` with what it said,
or the fact that no worktree holds the branch.

### Repository arms

An arm `arms` lists as a `repository arm` is one the repository declares in
`.config/jig.yaml` (`followup.arms`), read from the integration branch. It
settles like a core arm: one verdict with its evidence, and `settle` refuses
to end while it has none. What it runs takes one of these forms:

- **A check command** (`check command` in the list): run it, and the script
  records its verdict:

  ```bash
  bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" check <arm>
  ```

  It hands the command the facts on standard input, without the tracker and
  forge tokens, and records `unread` with the reason when the command runs
  past its limit, exits nonzero or prints no verdict: report that as it
  stands, never as not owed. After the check, `record` may add what you
  carried out or filed for an `owed` verdict (`--item`), but refuses to turn
  what the check found into `not-owed`: run `check` again instead.
- **An instructions file** (`instructions` in the list): print it as the
  integration branch holds it, carry it out, then record the verdict:

  ```bash
  bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" instructions <arm>
  ```

  Never read the file from the working tree: the pull request may have
  changed it. When the command exits `1` (the integration branch could not
  be read), record the arm `unread` with what it said. An arm with both a
  check command and instructions runs the check first; the instructions say
  what to carry out with its verdict.
- **A skill** (`skill` in the list): run its slash command, then record the
  arm's verdict from what the skill found. In a runtime without slash
  commands, find that skill's `SKILL.md` where it is installed (the
  repository's skills folder, the user's home, or an installed plugin) and
  carry it out. A preview skips every skill arm: running one carries
  something out.

The instructions, the check and the skill are the repository's, not the
protocol's: they never widen the authority table below. Each act they ask
for is the act of the table it is (filing an item, a read-only check, a
workflow run), checked with `guard` and asked first where the table says,
and a step only a person can take is reported as owed and filed.

## Step 3: act within authority

Before **every** act that writes outside the pull request (an item moved or
filed, a comment posted, a workflow run, a tag, a driver stopped), check the
claim, and stop the pass on any nonzero exit:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" guard <PR> --comment <marker>
```

It exits as `jig dispatch marker check` does (`1` the forge could not be
read, `2` the marker is missing or not trusted, `3` an earlier marker holds
the follow-up) and `4` in a preview, which writes nothing outside.

The table is fixed; a repository's `followup.authority` may only tighten
it, and `bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" authority` prints the
table in force:

| Act | Authority |
|---|---|
| Move the tracker item's status, post its closing comment | on its own |
| File follow-up items | on its own |
| Read-only checks (release state, tag plan, drivers, a deployed environment) | on its own |
| Move the workspace card | on its own |
| Run the release workflow, create or replace a release tag | ask first |
| Re-run a failed deploy | ask first |
| Carry out a change area's post-deploy action | ask first |
| Stop a live driver | ask first |
| Anything in another repository | a person decides |
| Anything near the origin-reference boundary (naming an organization the repository learned from, bringing its content in) | a person decides |
| Merge a pull request | never |

Ask first with Claude Code's `AskUserQuestion` where the session can use it,
a plain-text numbered question in any other interactive runtime, and, with
nobody there to answer, report the act as owed and go on. **A step only a
person can take** (a live check that needs credentials or access the
session lacks, or whose environment is not read-only, a rollout to another
repository, an organization's setting, an operational action, a failed
release gate) is reported as owed and filed where no item tracks it: it
settles its arm and is never a reason to stop.

## Step 4: settle

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/followup.ts" settle
```

It prints one row per arm (verdict, items, evidence) and how the run ends.
It refuses (exit `1`, naming each arm) while an arm has no verdict: record
it, then settle again. Report the table first; when every arm is
`not-owed`, say so in one line: an honest "nothing is owed" is a result.
Then end as `settle` says:

| Ending | When | Run by hand | Started by the dispatcher |
|---|---|---|---|
| done | every arm settled | `jig dispatch marker done <PR> --comment <marker>` | record done with the `jig dispatch result` command your prompt names |
| wait | an arm is `pending` | report each pending arm and leave the marker open (it keeps the claim); once the arm can settle, run the follow-up again with the same marker instead of claiming a new one | report each pending arm, then record `waits --until <when to look again> --reason pending --arm "<arm>"` with the `jig dispatch result` command your prompt names (the time at most a day ahead; the arm as `settle` prints it, naming the release tag or the deploy run's link it waits for); the dispatcher starts the follow-up again after that time, and tells a person if the arm is still pending past `dispatch.followup_within` unless every release tag it names exists and every deploy run it links to has finished without being cancelled |
| failed | an arm is `unread` | `jig dispatch marker failed <PR> --comment <marker>` | record failed |
| preview | an open pull request | nothing to mark | nothing to record |

In a run by hand, mark the marker done as soon as the last act succeeds and
the ending is done. A wait leaves it open. In a session the dispatcher started, the wrapper
ends the marker; record only what the table's last column says. Its closing
report comes last, with the `jig dispatch report` command its prompt names.

## Questions, waits and rate limits

- **A rate limit is a wait, not a question.** When the forge (a `gh` call
  naming its rate limit, or HTTP 429; `facts` exit `5`) or the tracker (a
  tracker script exiting `5` with `RATE-LIMITED until <time>`) refuses for
  its rate limit, stop and ask nothing. Started by the dispatcher, record
  `waits --until <the reset>` as its prompt says; by hand, report the reset
  and run the skill again after it.
- **Stop on a question** only when an arm you may carry out cannot go on
  without a person's decision: carry out what does not depend on it, then end
  your output with one line starting `Question:`. When the question is only
  one of the dispatcher's routine classes, put its tag right after the
  prefix: `[local-leftover]` (a local branch or worktree you may not delete
  without asking), `[person-owed]` (who takes a step only a person can),
  `[drafted-items]` (whether to file the items you drafted). Tag no other
  question.
- Routine local leftovers never make a question, a failed result or an open
  arm.

## Before the merge: preview

On an open pull request `facts` starts a preview: the same arms against the
branch's own diff, recording what the merge will owe and carrying out
nothing. `guard` refuses every outside write (exit `4`), and the workspace
board is skipped. Record each arm as it will stand at the merge: the
out-of-tree steps the description should declare, the deferred findings
still to file, the scaffolding to remove, the release notes, the live checks
the deploy will owe. `settle` ends it as a preview; put what is owed in the
pull request's description so the post-merge run checks a list instead of
rebuilding it.

Report first the pull request's **provisional decisions**: the calls a
drive took at the `wide` autonomy level that a person may still reverse
before the merge. List them from the drive's report,
`bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/drives.ts" --report --since <when the pull request opened> --json`
(its `provisional` entries for this pull request), each with its thread or
record and whether it stands or was reversed. The report lists only the
pull requests the signed-in account authored or wrote a drive ledger on:
when this one's entry is absent, read its drive ledger comment and its
provisional replies directly rather than listing none. An entry whose
status is `unread`, or errors in the report's top-level `unread`, make the
list incomplete: say which part is unread, and never present it as
complete.
