# Follow-up arm: the website

What a merge into Jig owes jig-harness.dev. The site renders the
repository's documents at build time and deploys every push to `main`
(`design/website.md`), so most merges change it, and some change what it
says without changing its pages. This arm runs on every merge. Paths are
from the repository root; `range.base` and `range.head` are the merge facts'
range (`followup.ts facts`).

Record one verdict for the arm with the follow-up's `record` command:
`owed` with each item filed, `pending` while the deploy has not finished,
`not-owed` with the answers below as its evidence, `unread` when the
deploy or a build could not be read.

## 1. Did it deploy?

```bash
gh run list --workflow website.yml --commit <range.head> --json databaseId,status,conclusion,url
```

- Not started or still running: read the newest such run first, as the
  skill says for a deploy that has not finished
  (`bun <followup skill>/scripts/followup.ts deploy-run <databaseId>`).
  - `moving`: `pending`, with the run's link (in a dispatched pass, in
    `--arm` as well), until it ends.
  - `stuck`: the deploy queue is held and the run cannot start. Record the
    arm `owed` as a step owed by a person, with the run's link and its
    `reason` as evidence and, as `--item`, the open issue that tracks the
    stuck deploy queue (search open issues for one before filing a new
    one), then answer 2 and 3 and finish the other arms.
- Failed: read its log (`gh run view <id> --log-failed`) and record the
  arm `owed` with the cause. Re-running the deploy is an act the follow-up
  asks first about (`deploy-rerun`); with nobody to ask, file the failure
  and report it as a person's step.
- Succeeded: the deploy is settled; go on.
- Cancelled, skipped or timed out, or no run for that commit: a later
  commit's deploy supersedes it. Look at the newest `website.yml` run on
  `main` (`gh run list --workflow website.yml --branch main --limit 1 --json databaseId,headSha,status,conclusion,url`).
  When the listing cannot be read, record `unread`. When that run has not
  finished (queued or in progress) and its commit contains `range.head`
  (`git merge-base --is-ancestor <range.head> <that commit>`), read that
  run with `deploy-run` and record it as above: `pending` with its link
  while it is `moving`, a person's step while it is `stuck`. When it succeeded and its
  commit contains `range.head`, the merge is deployed and this part is
  settled. Otherwise (it failed, or its commit does not contain
  `range.head`) record the arm `owed` with the run's link as the actionable
  evidence.

## 2. What did the merge change on the site?

Compare the site built before and after the merge, page by page:

```bash
bun scripts/site-diff.ts <range.base> <range.head>
```

It builds both commits in temporary worktrees (a minute or two each) and
prints the pages added, removed and changed, with the lines that changed in
each page's main content. Read the result as a reader of the site would. A
page that lost a section it should keep, a fragment that renders badly (a
table cut short, raw Markdown, a heading in the wrong place), or a changed
page the merge should not have reached is owed. To look at a page, rerun
with `--keep`, open the built file, and remove the worktrees afterwards
(`git worktree remove --force <dir>`).

## 3. What should have changed and did not?

Some of the site is written by hand rather than rendered: the pages and
components in `website/src/`, and the statements in `website/src/lib/data/`
(`NOT_BUILT` in `factory.ts`, for one, names the roadmap items the factory
page draws as not built). For each fact the merge changed (a finished
roadmap item, a renamed or new skill, a count of modules, stations or
levels, a module's or skill's name), search `website/src/` for the old fact.
A match the merge did not update is owed; the diff in 2 cannot show it,
because that page did not change.
`.claude/skills/website-update/references/what-the-site-holds.md` lists
where hand-written facts live and what each parser relies on.

When the merge changed the site itself (`website/`), check also that
`design/website.md` still describes it and that its build order no longer
lists what the merge built.

## Releases on the site

`/whats-new/` links each release to its tag. When the release arm found a
version untagged, the link is broken until the tag exists: name it in this
arm's evidence beside the release arm's item, filing nothing more. When a
release's link lands on the wrong commit, report it as a person's step.

## What to carry out

File one item for everything this arm found owed in the site's
hand-written text and in Jig's documents, with the pages and the facts, so
one follow-up pull request fixes them; read `docs/VOICE.md` before wording
a fix to the site's copy or to a visitor document. The follow-up files on
its own (`file-items`) and opens no pull request: the item is the next
step's to weigh, and a maintainer running the follow-up by hand may take it
up with `/jig:do-item` once the pass has settled.

## Before the merge

In a preview, answer 2 against the branch (`range.base` is where it left
`main`, `range.head` its head) and 3 against its diff, and leave 1 to the
merge. Building the head runs the pull request's code (its install and the
site's build scripts) with your credentials: build it only on a branch of
this repository whose diff you would run the gates on, and otherwise record
the arm `pending` until the merge, saying why.
