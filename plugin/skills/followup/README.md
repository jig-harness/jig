# followup

**What problem this solves.** Merging a pull request closes the pull
request, not the work. Without a pass after the merge, the tracker item
stays open or is closed while a step a person must take is still undone, a
review finding someone agreed to defer is never filed, a release waits
untagged, a skipped test or a running driver outlives the change, a deployed
change is never checked where it runs, and nobody names what comes next.
Each of these is easy to miss because nothing fails when it is missed.

This skill runs that pass, the post-merge stage of
[M7](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md#core-pieces),
in any repository that uses the `jig` plugin. It works through a fixed list
of **arms** (each one class of obligation a merge can leave), with any the
repository adds of its own, gives each a
verdict with the evidence that settled it, carries out what its authority
table lets it, and reports the rest as owed, filed where no item tracks it.
On an open pull request it runs as a **preview**: it records what the merge
will owe and carries out nothing.

The agent's contract is [SKILL.md](SKILL.md).

## Run it

```text
/jig:followup <PR number>
```

By hand after a merge, or started by the [dispatcher](../../README.md#the-dispatcher)
when the repository sets `dispatch.followup_command` to `/jig:followup`
and the machine turns the follow-up stage on. Either way a marker comment
on the pull request claims the follow-up first, so one run settles each
merge.

A release that still owes a tag and needs a person gets one tracker item
per version. Dispatched follow-ups refer to that item and finish once their
remaining checks settle. The dispatcher presents one decision for the
release with the options **Re-run the failed gates**, **Investigate**, and
**Tag it by hand**. It recommends the re-run unless the follow-up
recorded that no required check failed; where every check passed,
the version is outside automatic tagging, or the repository makes the tag a
person's step (`changelog.release.tagged_by: person`), it offers only the
last two and recommends tagging by hand. Untagged releases of a repository
that share a remedy share that decision, which lists every version it covers.
When another host runs the follow-up, it passes the owed release to the
repository's owner dispatcher, which finds or files the tracker item.
An owner with only the notification stage can process this handoff when
the repository configures a changelog.

## The arms

| Arm | It settles |
|---|---|
| `tracker` | The item the merge closes (its status under the post-merge status rule, its closing comment) and its epic's status; an epic closes only on an accepted verdict or a waiver |
| `deferred-findings` | That every review finding deferred to later has its item, resolved threads and summary findings included, with or without a tracker item |
| `out-of-tree` | Each step the `## Out-of-tree follow-ups` section lists: done or filed. A section that says "None" is evidence; no section at all is not |
| `release` | Where the repository keeps a changelog: that the release consumed the merge's notes and that every released version has its tag |
| `scaffolding` | Temporary scaffolding in the merged diff (a focused or skipped test, a suppression, a raised timeout, a gate turned off), a driver still running, temporary resources left in an environment |
| `live-verification` | Owed only when the change has a runtime surface, it reached a deployed environment and no CI check already covers the claim; the observation is reported, not the expectation; the change areas' post-deploy actions |
| `next-step` | What the merge implies next, preferring to finish a near-done epic, then operator work a code change can clear, then batches of small items; existing containers before new items |
| `workspace-board` | In Orca only: the merged work's card moves to completed |

Each arm ends **owed** (done or filed, with the item), **not owed** (with a
checkable fact; "nothing found" is not one), **pending** (it settles by
itself, such as a rollout in progress) or **unread** (what decides it could
not be read). The run cannot end while an arm has no verdict. A pending arm
ends a run the dispatcher started as a wait: the dispatcher starts the
follow-up again after the time the run names, and tells a person when the
arm is still pending past `dispatch.followup_within`. A run started by hand
reports the pending arm, and a person runs it again once the arm can
settle. A deploy whose run cannot start is not pending: the script's
`deploy-run` command reads a run with no jobs, behind a still-running run of its
workflow whose queue has held cancelled runs past a bound, as `stuck` (its
workflow's concurrency group is held), and the arm records it as a step owed by a person instead of
waiting on it.

### The repository's own arms

What one repository owes after a merge and no other does (a documentation
site to rebuild, an operations ledger to append to, a verification its team
already keeps in a skill) is a **repository arm**, declared in
`.config/jig.yaml` under `followup.arms`. It runs before `next-step`,
applies to the change areas its `when` names (every merge when it names
none), and is settled under the same rules as the core arms. It runs one of:

| Form | What runs | Read from |
|---|---|---|
| `instructions` | An instructions (prompt) file the agent carries out | The integration branch, never the pull request's tree, so a pull request cannot rewrite the arm that follows it up |
| `check_command` | A read-only command: the merge facts as JSON on standard input, one verdict JSON on standard output; the script records it | The integration branch's configuration; it runs without the tracker and forge tokens, within a time and output limit, and anything but a verdict is recorded unread, never not owed |
| `skill` | A skill's slash command, from the repository, the user's home or an installed plugin; a preview runs none | Wherever the skill is installed |

An arm may pair an instructions file with a check command. No repository
arm widens the authority table: what it carries out is an act of the table
like any other.

## The script

`scripts/followup.ts` holds the protocol, so every repository's follow-up
follows the same steps:

| Command | What it does |
|---|---|
| `facts <PR>` | Reads the merge facts as JSON (the state, the merge commit and the range it brought in, the changed files and change areas, the tracker item and epic, the out-of-tree steps, scaffolding candidates) and starts the run's ledger under `.context/scratch/followup/` |
| `arms` | The arms this run settles, the repository's own included, and the ones it skips with why |
| `record <arm> <verdict> --evidence <text> [--item <ref>]` | Records one arm's verdict; refuses empty evidence |
| `check <arm>` | Runs a repository arm's check command and records its verdict, `unread` when it does not answer |
| `instructions <arm>` | Prints a repository arm's instructions file as the integration branch holds it |
| `guard <PR> --comment <marker>` | Checks the run still holds the follow-up before an act outside the pull request; refuses every such act in a preview |
| `settle` | The report, one row per arm, and how the run ends: done, a wait, failed, or a preview |
| `authority` | What the follow-up may do, as the repository's configuration tightens it |
| `release` | What the release arm reads: the merge's change notes and whether each still waits for a release, and the changelog skill's status report from a throwaway checkout of the integration branch |

## Authority

| Act | Authority |
|---|---|
| Tracker status and closing comment, filing items, read-only checks, the workspace card | on its own |
| Running the release workflow or making a tag, re-running a deploy, a post-deploy action, stopping a live driver | ask first |
| Anything in another repository, or near the origin-reference boundary | a person decides |
| Merging | never |

A step only a person can take is reported as owed and filed; it never stops
the pass. A rate limit is a wait, never a question.

## Configuration

The fields in `.config/jig.yaml`, all optional
([CONFIGURATION.md](../../CONFIGURATION.md#followup)):

```yaml
followup:
  off: [workspace-board]          # core arms this repository does not run
  authority:
    file-items: ask               # tighten an act; never loosen one
  arms:                           # the repository's own arms
    - id: docs-site
      when: [docs]
      instructions: .config/followup/docs-site.md
    - id: ops-ledger
      check_command: bun scripts/ledger-check.ts
```

The follow-up reads them from the integration branch's committed file when
the clone has it, so a pull request's own change to them does not decide
its preview. It also reads `changelog.file` (the release arm),
`repository.base_branch`, `pull_requests.branch_name` and
`pull_requests.base_rules` (the facts), `issue_tracker` (the item's key),
`drive.validation_plan_command` or `drive.change_areas_catalog` (the change
areas), `do_item.post_merge_state` (the item's status) and
`issue_tracker.labels.manual_ops` (out-of-tree steps).

## Works with

- [do-item](../do-item/SKILL.md): its post-merge status rule and its epic
  close, which this skill calls rather than restates.
- [resolve-review-comments](../resolve-review-comments/README.md): the
  deferral protocol that files deferred findings.
- [file-issue](../file-issue/README.md): every new item the pass files.
- [changelog](../changelog/README.md): the release state and the tag plan.
- [change-areas](../change-areas/README.md): the areas a merge touched and
  their post-deploy actions.
- [drive-pr](../drive-pr/README.md): live drivers, and summary findings.
- [work-batch](../work-batch/README.md): where small next items go together.
