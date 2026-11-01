---
name: followup
description: "After a Jig pull request merges, settle what the merge still owes: the tracker item and deferred findings, the release tags, the website, status pages, consumer repositories and cleanup; or, before the merge, list what it will owe."
argument-hint: "<PR number>"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Bash
---

# Followup: what a merged Jig pull request still owes

Merging closes the pull request, not the work. A merge into Jig can leave a
release untagged, a page of jig-harness.dev saying something the documents
no longer say, a roadmap item still open elsewhere, a copy of a moved tool
alive in the repository it came from, or a driver still running. Nothing
else checks these after the merge. This skill runs one pass over them,
reports each as **owed** or **not owed** with the evidence that settled it,
and carries out the ones it may carry out on its own.

This is Jig's own post-merge pass, for this repository. The general stage for
[consumer repositories](../../../GLOSSARY.md) is stated in
[M7](../../../modules/M7-pr-lifecycle-review/README.md#core-pieces) and not
built as a skill yet (FACTORY.md, station 7). The pass orchestrates the procedures that already exist and does
not restate them: [`do-item`](../../../plugin/skills/do-item/SKILL.md) owns
tracker statuses,
[the deferral protocol](../../../plugin/skills/resolve-review-comments/references/deferral-protocol.md)
owns deferred findings, [CONTRIBUTING.md](../../../CONTRIBUTING.md) owns how a
follow-up change is made, and [design/website.md](../../../design/website.md)
owns how the site is built.

Run it from the repository root, in the session that drove the pull request
when there is one: the facts are still in its context.

## Step 0: establish the merge facts

```bash
PR=<number>
gh pr view "$PR" --json number,title,state,mergedAt,mergeCommit,baseRefName,headRefName,headRefOid,body,labels
```

- `state` must be `MERGED` and `baseRefName` `main`. On an open pull request,
  run the [preview](#before-the-merge-preview) instead and carry out
  nothing.
- `SHA` is `mergeCommit.oid`. Jig squash-merges, so `SHA^1` is `main` just
  before the merge, and `git diff --name-only SHA^1 SHA` is the change.
- The tracker item: `Closes #<n>` in the body, else the issue number the
  branch name carries (`<n>-<slug>`). Leave it empty when neither names one.
  `Part of #<n>` names the epic a step belongs to, not the item the merge
  closes.
- Fetch first: `git fetch --no-tags origin main`. Leave this clone's tags
  alone: a fetch that updates them refuses a tag origin holds elsewhere
  ("would clobber existing tag"), and [B](#b-tagging-the-release) reads
  origin's tags, not this clone's.

### Claim the follow-up

The dispatcher (`jig dispatch`, [the plugin's README](../../../plugin/README.md#the-dispatcher))
starts this pass by itself for a merged pull request, and a marker comment
on the pull request is what keeps two runs from settling the same merge.
Before any arm acts, claim it:

```bash
jig dispatch marker claim "$PR"     # prints {"pr": …, "comment": <id>}
MARKER=<id>
```

Exit `3` means an earlier marker holds the follow-up: another run has it,
so stop here and say so. When the dispatcher started this session, its
prompt names the marker it posted: that claim is this session's, so use
that id as `MARKER` and post none of your own.

Before each act that writes outside the pull request (an issue closed, a
release workflow run, a tag pushed), check the claim again, and stop on exit
`3`:

```bash
jig dispatch marker check "$PR" --comment "$MARKER"
```

When the pass ends with every arm settled, a claim you posted is marked
done, so the dispatcher never starts the follow-up again:

```bash
jig dispatch marker done "$PR" --comment "$MARKER"
```

A session the dispatcher started records its result with the
`jig dispatch result` command its prompt names instead. A run that stops
short leaves its marker as it is: the dispatcher reports it, and a person
marks it done or deletes it to have the follow-up run again.

## Step 1: the arms

Each arm ends **OWED** (with the concrete item) or **NOT OWED** (with the
reason). "Nothing found" is not a reason; "no file under `plugin/` changed"
is.

### A. The tracker item and deferred findings

1. **Status and closing comment**: `do-item`'s post-merge status rule decides
   between done and ops-pending. An item that is itself a roadmap epic
   (the `roadmap` flag), worked directly, stays open while its plan item is
   still in `design/plan.md`, as in step 3. The closing comment carries the pull
   request's `## Out-of-tree follow-ups` section as unchecked boxes, and the
   merge commit.
2. **Deferred findings**: every `**deferred**` reply was meant to become a
   follow-up item. Check that each exists rather than trusting the reply. A
   deferred thread is resolved as soon as its reply posts, so include the
   resolved ones. A summary-only finding has no thread: its answer is a
   comment on the pull request carrying a `drive-pr-addressed` marker, and
   `summary-findings.ts` reports only whether a finding was answered, not
   how. Read the answers themselves:

   ```bash
   bun plugin/skills/resolve-review-comments/scripts/list-unresolved-threads.ts "$PR" --include-resolved
   gh api "repos/{owner}/{repo}/issues/$PR/comments" --paginate \
     --jq '.[] | select((.body | contains("drive-pr-addressed")) and (.body | startswith("**deferred**"))) | .html_url + "\n" + .body'
   ```

   File what is missing with `defer-batch.ts`, as the deferral protocol says.
3. **The epic**: when the item has a parent, `do-item`'s parent-status rule
   (`reconcile_parent_status.ts`) decides its status. It sees only the
   children's states, so for an epic that also carries the `roadmap` flag
   check first that its plan item has left `design/plan.md`
   ([label-taxonomy.yaml](../../../label-taxonomy.yaml)). While the item is
   still there, the epic stays open whatever its children say.

Without a tracker item, 1 and 3 are NOT OWED; 2 still applies.

### B. Tagging the release

Every Jig release is tagged `v<version>` on the commit that shipped it
([CONTRIBUTING.md § Releasing the
plugin](../../../CONTRIBUTING.md#releasing-the-plugin)). After the merge,
the release workflow (`.github/workflows/release.yml`) writes the change notes
into CHANGELOG.md and moves the version on a commit of its own, and tags that
commit once its gates pass.
First check that it consumed this merge's notes, by the merge's own notes and
the release run, not by what `changes/` holds on main: another merge may have
added a note since, and its run may be queued or running. The merge's notes
are the notes it added, edited or renamed into place, counted as the release
step counts them: Markdown files directly in `changes/`, other than a README
in any letter case
(`git diff --name-only --diff-filter=AMR <merge>^ <merge> -- ':(glob)changes/*.md'`,
which names a renamed note by its new path, after `git fetch origin main`).
Then read where releases stand on main with the changelog skill's `status.ts`,
from a throwaway checkout of `origin/main` (the working tree is the branch it
reads), fetched immediately before it:

```bash
git fetch origin main
CHECKOUT=$(mktemp -d)
git worktree add --detach "$CHECKOUT/main" origin/main
bun plugin/skills/changelog/scripts/status.ts --root "$CHECKOUT/main" --json \
  >"$CHECKOUT/status.json" 2>"$CHECKOUT/status.err"
echo "status.ts exit $?"; cat "$CHECKOUT/status.json" "$CHECKOUT/status.err"
git worktree remove --force "$CHECKOUT/main"
```

Remove the checkout whatever `status.ts` did. It exits 1 with its report
when a note is unreadable or the last release run failed, which the table
below reads; when it prints no report (the version files on main disagree:
exit 1; an invalid configuration or an unreadable file: exit 2), none of the
table's rows applies. Report the release state as unread, owed investigation,
with the exit status and what it wrote to standard error, and go on to the
tags.

`releasing`, `waiting` and `unreleased` list the readable notes still in the
folder, `errors` the ones the release step cannot read (each names its file,
and any one of them stops the release), and `releaseRun` is the newest run of the `release` workflow on main that is
still going, else its newest run: a release run still going is never
cancelled by a later one (the later run waits, and a newer run replaces the
waiting one, cancelling that one instead), so an older run still going can yet
consume the note, and a cancelled run's notes fall to the run that replaced it (`state`: `running`, `success`, `failure`, `none` or `unknown`, read through
`gh`). Since a note `errors` names is in none of the lists, check that the file is
there before reading the lists (`git cat-file -e origin/main:<note>`). A note
of the merge is still there only when its file is on main and
main's last addition of that path is the same commit as its last addition at
the merge, the way the release step dates a note
(`git log --first-parent --diff-filter=A -1 --format=%H <ref> -- <note>`,
with `<ref>` first `origin/main`, then the merge): a note the merge only
edited is still the note it edited, while a file name a release deleted can
be reused, and the later merge's note is not this one's. Then:

| What you find | It means |
|---------------|----------|
| No note of the merge is still there, or the merge added none | Released, or nothing to release: go on to the tags |
| A note of the merge is still there and `errors` names it | The release cannot read it, so no run will consume it: report it with the error, as a person's step, whatever the run says |
| A note of the merge is still there and `releaseRun.state` is `running` | Pending: say so, and when the run finishes repeat the whole read (fetch, a new checkout, `status.ts`, the note checks) — `status.ts` alone reads the old checkout's notes; not an incident |
| A note of the merge is still there and `releaseRun.state` is `success`, `failure` or `none`, and it still is when the whole read is repeated | The workflow did not consume it (most often, the `jig-release` App can no longer push: its key in the `release` environment was rotated or removed, or `main`'s ruleset no longer lets it past): report it with the run's link, as a person's step |
| A note of the merge is still there and `releaseRun.state` is `unknown` | Not readable here (no `gh`, no origin, or a listing `gh` may have cut short): look at `gh run list --workflow release.yml --limit 10` by hand and say that it was not read |

A note on main that a later merge added is that merge's to settle, not this one's.
Then check the tags on every merge,
whatever it changed: a tag an earlier release left owed is owed now. The
release workflow makes them itself: it tags each version's releasing commit
(the first commit on main whose CHANGELOG.md has the version's heading) once
`gates` passed on that commit. `status.ts`'s report above already holds the
picture, in `tags`: `known: false` with a `detail` when it could not be read
(no `gh`, no origin), else `untagged`, every released version origin has no
tag for, each with its `state`, its releasing `commit` and the checks
`failing`. For the whole plan (every required check's verdict and link), run
the changelog skill's tag plan; it reads the changelog and the history from
`origin/main` and the tags from origin, never from the working tree:

```bash
bun plugin/skills/changelog/scripts/tag.ts --json
```

| `state` | It means |
|---------|----------|
| no entry (`untagged` empty) | NOT OWED |
| `pending` or `rerun` | Pending: the gates on the releasing commit are still running, or were cancelled and the workflow runs them again once; check again later, not an incident |
| `ready` | OWED: the gates passed but no tag job has run since; run the release workflow (`gh workflow run release.yml`), ask first |
| `failed` | OWED, a person's step: the gates failed on the releasing commit; report it with the failing checks, and never tag it by hand |
| `imported` | OWED only if that version was ever owed a tag: its heading came in with others, so no commit released it; report it for a person |

`tags.known: false` is unread, not NOT OWED: say so with its `detail`. A tag
on origin of the version's name counts as made, whatever it points at; when
a release link on the site (`/whats-new/` links each release to its tag)
lands on the wrong commit, report it as a person's step. An untagged release
is also a broken link there.

Machines receive a release only when they update the plugin: say so, with the
update command from [plugin/README.md](../../../plugin/README.md#update-pin-or-remove),
when the merge changed a skill this session uses.

### C. The website

The site renders the repository's documents at build time and deploys every
push to `main` ([design/website.md](../../../design/website.md)), so most
merges change it. Three questions:

1. **Did it deploy?**

   ```bash
   gh run list --workflow website.yml --commit "$SHA" --json status,conclusion,url
   ```

   A failed run is OWED: read its log (`gh run view --log-failed`). Not
   started yet is "awaiting deploy": report it and check again later.
2. **What did the merge change on the site?** Compare the site built before
   and after the merge, page by page:

   ```bash
   bun scripts/site-diff.ts "$SHA^1" "$SHA"
   ```

   It builds both commits in temporary [worktrees](../../../GLOSSARY.md)
   (about a minute each) and prints the pages added, removed and changed,
   with the lines that changed in each page's main content (in order, with
   heading levels and link and image targets). Read the result
   as a reader of the site would: a page that lost a section it should keep,
   a fragment that now renders badly (a table cut short, raw Markdown, a
   heading the page lays out in the wrong place), a changed page the merge
   should not have reached. Each is OWED. To look at a page, rerun with
   `--keep` and open the built file. `--keep` leaves the worktrees, so
   remove them afterwards (`git worktree remove`).
3. **What should have changed and did not?** Some of the site is written by
   hand rather than rendered: the pages and components in `website/src/`,
   and the statements in `website/src/lib/data/` (for example
   `NOT_BUILT` in `factory.ts`, which names the roadmap items the factory
   page draws as not built). For each fact the merge changed (a finished
   roadmap item, a renamed or new skill, a count of modules, stations or
   levels, a module's or skill's name), search `website/src/` for the old
   fact. A match the merge did not update is OWED, and the diff in 2 cannot
   show it, because that page did not change.

When the site itself changed (`website/`), also check that
[design/website.md](../../../design/website.md) still describes it and that
its build order no longer lists what the merge built.

### D. Status pages and the documents that cite them

- **The roadmap**: an item the merge finished has left both
  [design/plan.md](../../../design/plan.md) and the public
  [ROADMAP.md](../../../ROADMAP.md), and the change is in
  [CHANGELOG.md](../../../CHANGELOG.md). Then search the repository for the
  places that still cite it (`grep -rn "item <n>\b"`, FACTORY.md's "Not built
  yet", `design/*.md` build orders): each is OWED.
- **The glossary**: a term of art the merge introduced is in
  [GLOSSARY.md](../../../GLOSSARY.md) (the gates catch acronyms only).
- **The auditor**: the pull request description said what changed in the
  audit (CONTRIBUTING.md § Keeping the auditor current). When the merge
  targeted criteria, the next audit (`/jig:audit`) is what scores them:
  report it as owed work, with the criteria named, rather than running it
  here.

### E. Consumer repositories

Jig names no consumer in its own content; the consumer's repository and
tracker are where this arm's work goes.

- **Move, never copy**: when the merge brought a tool in from a consumer
  repository, deleting the source's copy in the same rollout is OWED there.
  File it on the tracker for that repository (its label is in
  `review.taxonomy.repos` in `.config/jig.yaml`); never edit another
  repository from this pass.
- **Breaking changes**: a release marked **Breaking** owes each consumer the
  change its changelog section names. File one item per affected consumer.
- **Backflow** (a lesson the merge learned that a consumer's practice should
  take, or the reverse): file it; whether Jig takes a consumer's practice is
  decided in its own pull request.

Anything that would name a consumer, or bring its content into Jig, is a
decision for a person (AGENTS.md, HITL decisions): flag it.

### F. Cleanup

| Thing | Check | Teardown |
|---|---|---|
| A live driver on this pull request | `bun plugin/skills/drive-pr/scripts/drives.ts` | `drives.ts --stop <PR>` |
| The driver's log | listed by `drives.ts` | keep it; it is the record |
| The local branch | `git branch --list <headRefName>` (Step 0). A squash merge leaves it out of `git branch --merged`, so Step 0's `MERGED` state shows only that the pull request's head merged; `git rev-parse <headRefName>` must equal Step 0's `headRefOid` for the branch to hold nothing else | delete it, only when its tip is `headRefOid` and no driver is live in this worktree. Any other tip holds commits the merge does not have: push them to a branch of their own, or ask, before deleting |
| The workspace's `.context/` notes | what this work wrote there | remove what no later work needs |
| Scaffolding in the merged diff | a disabled check, a `.only(`, a loosened timeout, a suppression | a follow-up change |

Never `git stash` any of this (CONTRIBUTING.md § Parallel workspaces).

### G. What comes next

What the merge implies, as concrete work rather than advice:

- **Sweep the class**: when the merge fixed a defect, search for its siblings
  elsewhere in the repository.
- **Scope cuts**: anything the description or the review rounds narrowed or
  carved out, that no item tracks yet.
- **The next item**: the epic's next sub-issue, or the roadmap's next open
  item, handed to `/jig:do-item`.
- **Knowledge**: a lesson that belongs in the team's documents
  (`/jig:promote-memory`).

Before filing anything new, search the tracker for an item it belongs to.

## Step 2: report, then act within authority

Report first, one row per arm: OWED or NOT OWED, the item, the evidence. Then
act:

| Action | Authority |
|---|---|
| Tracker status, closing comment, filing follow-up items (here or for a consumer) | on its own |
| Fixing what the pass found in Jig's documents or the site's hand-written text | on its own: one follow-up pull request for all of it, opened as a draft (CONTRIBUTING.md) |
| Read-only checks: `status.ts`, `tag.ts` (without `--rerun`), `site-diff.ts`, `drives.ts`, `gh run` | on its own |
| Running the release workflow, creating or replacing a release tag | ask first |
| Re-running a failed deploy | ask first |
| Stopping a live driver, deleting a branch or a worktree | ask first |
| Anything in another repository, or anything near the origin-reference boundary | a person decides |

Close with what is left for a person, by name. When every arm is NOT OWED,
say so in one line: an honest "nothing is owed" is a result. Then settle the
claim ([Claim the follow-up](#claim-the-follow-up)): mark your marker done,
or, in a session the dispatcher started, record the result its prompt
names.

## Before the merge: preview

On an open pull request the skill runs the same arms against the pull
request's diff (`origin/main` and its head instead of `SHA^1` and `SHA`) and
records what the merge will owe, carrying out nothing: the
`## Out-of-tree follow-ups` section of the description, the deferred
findings still to file, the site pages the change will reach, the cleanup
inventory, and first of all the pull request's **provisional decisions**: the
calls a drive took at the `wide` autonomy level that a person may still
reverse before the merge. List them from the morning report
(`bun plugin/skills/drive-pr/scripts/drives.ts --report --since <when the
pull request opened> --json`, its `provisional` entries for this pull
request), each with its thread or record and whether it stands or was
reversed, so the person merging reads them before they merge. The report
lists only the pull requests the signed-in account authored or wrote a drive
ledger on, so a pull request someone else opened and drives from another
clone may be missing: when its entry is absent, read that pull request's
drive ledger comment (`<!-- drive-pr-ledger -->`) and its provisional replies
directly rather than listing none. A provisional entry whose status is
`unread`, or a report that exits 0 with errors in its top-level `unread`
field, is not a complete inventory: say which part is unread and retry before
the merge, never present the list as complete. The post-merge pass then
checks a list instead of rebuilding it.

Building the head for `site-diff.ts` runs the pull request's code (its
install and the site's build scripts) with your credentials. Run it only on a
branch of this repository whose diff you would run the gates on; for any
other, skip the site arm in the preview and leave it to the post-merge pass.
