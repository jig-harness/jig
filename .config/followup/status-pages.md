# Follow-up arm: the status pages

What a merge into Jig owes the pages that say what is open: the
maintainers' plan (`design/plan.md`), the public roadmap (`ROADMAP.md`) and
the documents that cite their items. A status page lists open work only,
and a finished item leaves every page that lists it in the pull request
that finishes it (AGENTS.md, writing conventions). This arm checks that it
did. Paths are from the repository root.

Record one verdict for the arm with the follow-up's `record` command:
`owed` with each item filed, `not-owed` naming the plan items the merge
touched (or that it touched none, and why: no item it closes is a plan
item's epic or that epic's last open step), `unread` when the tracker or a
file could not be read.

## 1. Did the merge finish a plan item?

A plan item has an epic issue labelled `roadmap`. The merge finished one
when the item it closes is that epic, or is the epic's last open step and
the epic's designed scope is delivered. Read the items and epics from the
merge facts (`items`, `epics`) and each epic's sub-issues through the
tracker scripts.

When it did:

- the item has left both `design/plan.md` and `ROADMAP.md`, and what
  changed is in a change note or in `CHANGELOG.md`;
- nothing still cites it as open: search for `item <n>\b` across the
  repository, FACTORY.md's "Not built yet", and the build orders in
  `design/*.md`. The gates already refuse a rendered document that cites an
  item the roadmap lacks (`scripts/check-roadmap.ts`), so look hardest at
  what they do not read: `design/`, the `AGENTS.md` files, CONTRIBUTING.md
  and code comments.

Each place that still lists or cites the item as open is owed.

## 2. A roadmap epic stays open while its plan item is listed

An epic labelled `roadmap` is closed only once its plan item has left
`design/plan.md`, whatever its children's states or the tracker arm's epic
rule say. When the tracker arm would close or has closed such an epic while
its item is still in the plan, record this arm `owed`: either the plan item
was left behind (file its removal) or the epic is not finished (reopen it,
and say so in the tracker arm's evidence).

## 3. What comes next on the plan

When the merge finished a plan item, name the plan's next open item in
this arm's evidence, so the next step can weigh it beside the epic's own
next step. Filing nothing for it: the next step decides.

## What to carry out

File one item for everything this arm found owed, with the places named,
so one follow-up pull request fixes them; or add them to the item the
website arm files for the same merge when it files one. The follow-up opens
no pull request of its own.

## Before the merge

In a preview, check 1 against the branch: when the pull request finishes a
plan item, its own diff should already remove the item from both pages and
from what cites it. Record what is still missing as what the merge will
owe, so the description can carry it.
