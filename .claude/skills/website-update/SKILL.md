---
name: website-update
description: "Bring the jig-harness.dev site up to date: review every commit to main since the site was last checked, edit what does not reach the site by itself, open one draft pull request, file follow-ups for what is too big, and report."
argument-hint: "[--to <ref>] [--max-lines N]"
disable-model-invocation: true
---

# Bringing the website up to date

The site in `website/` renders the repository's documents at build time, and
`main` deploys it on every push ([design/website.md](../../../design/website.md)).
So most changes reach it by themselves. What does not:

- **hand-written copy and hard-coded facts** in its pages, components and
  data helpers (counts, lists of skills or stations, roadmap item numbers,
  captions, what Jig never does);
- **a document's shape** a parser relies on: a renamed heading or table
  column usually drops content without failing the build;
- **a new kind of thing** (a module, skill, principle, profile, station,
  configuration layer) that a page lists by hand or a test counts;
- **the live audit example**, rendered from a committed run with its own
  caption.

This skill finds those among the commits since the last check, fixes them in
one pull request, and files follow-ups for what is too big to handle in one
session. It is Jig's own maintenance skill, not part of the plugin: a site
update is not a plugin release and carries no version or tag.

The last checked commit is in `website/content-sync.yaml`, written only by
`bun scripts/website-sync.ts --advance`. Read
[references/what-the-site-holds.md](references/what-the-site-holds.md)
before judging a commit.

## Phase 0 — Start clean

1. `git fetch origin`; stop and report if it fails.
2. Look for an open pull request from an earlier run, which is one that
   changes the record:

   ```sh
   gh pr list --state open --limit 1000 --json number,title,files \
     --jq '.[] | select(any(.files[]; .path == "website/content-sync.yaml")) | "#\(.number) \(.title)"'
   ```

   If one is open, stop and report it: a second run would review the same
   commits and conflict on the record.
3. Work on a clean checkout of the fetched `origin/main`, since the plan
   reads `origin/main` and the edits and checks must see the same files.
   The work goes on a feature branch, never `main`: reuse the current branch
   only when it is a branch other than `main`, has no commits of its own and
   `git merge --ff-only origin/main` brings it level; otherwise (on `main`,
   a detached checkout, or a branch with commits of its own)
   `git switch -c website-update/<YYYY-MM-DD> origin/main`. Then confirm
   `git branch --show-current` is not `main`, `git rev-parse HEAD` equals
   `git rev-parse origin/main` and `git status --short` is empty; stop and
   report if not.

## Phase 1 — Plan

```sh
bun scripts/website-sync.ts            # add --json for the fields
```

Pass this skill's arguments through: `--to <ref>` stops at another commit
than `origin/main`, `--max-lines N` moves the oversized bound.

It lists every commit of `main` after the recorded one, oldest first, with
its counted lines, the change-areas it touched and its kind:

| Kind | Meaning | What to do |
|------|---------|------------|
| `content` | touched a document or skill the site renders | review it (Phase 2) |
| `build` | touched the toolchain or another area that can break the build | nothing to read; Phase 4's build covers it |
| `site` | changed only the site itself | nothing, unless its message says it left something for later |
| `outside` | touched nothing the site reads | read the subject only, and review it if the subject says it changes a fact the site states |
| `update` | an earlier run of this skill: it changed the record, and nothing else it changed is content apart from its change note | nothing: that run checked its own edits |

Note the target commit it reports (`up to origin/main (<sha>)`): this run
covers exactly the commits up to it, even if `main` moves meanwhile.

No commits, or only `update` ones: report that the site is up to date and
stop, with no pull request. The record stays where it is; it advances on
the next run that has something else to check.

## Phase 2 — Review each `content` commit

Read only the paths the site renders:
`git show --stat --diff-merges=first-parent <sha>`, then
`git show --diff-merges=first-parent <sha> -- <path>…` for those paths. The
option compares a merge commit with its first parent, as the plan counted it;
without it a merge shows only what differs from both parents.
For each, ask the questions in
[references/what-the-site-holds.md § Questions](references/what-the-site-holds.md#questions),
and search the site for what changed (a heading, a term, a count, a name):
`grep -rn "<text>" website/src`. Record one verdict per commit:

- **site edited**: what you changed, and why the commit needed it;
- **nothing needed**: the change reaches the site by itself, or the site
  does not show it (say which);
- **follow-up**: what is left and why it was deferred (Phase 3).

**Oversized commits.** The plan marks a commit over 5,000 counted lines
(`--max-lines` changes the bound; lockfiles, fixtures and vendored code do
not count). Review its rendered paths when they are still small enough to
read whole; otherwise file a follow-up for it instead of judging it from
part of its diff. Do the same for any commit, or set of commits, that is too
large to review well in what is left of the session: an honest follow-up
beats a guessed edit.

## Phase 3 — Edit, or file a follow-up

- **The documents win.** The site is downstream of every document
  ([docs/README.md § Which document wins](../../../docs/README.md#which-document-wins)):
  fix the site to match them, never a document to suit the site. When a
  document's new shape breaks a parser, change the parser and its test.
  The one document this run does edit is [FEATURES.md](../../../FEATURES.md):
  it is a view of the skills, the stores and adapters, and the roadmap, so
  a skill added or renamed, a store or adapter built, or a roadmap item it
  names as not built that is finished is a change it owes; its tests say
  which feature, and the fix is the feature's text and its "On the roadmap"
  field.
- **Prefer deriving to retyping.** When a hand-typed fact has gone stale and
  the document it comes from already holds it, reading it from there (a
  parser, `site.ts`, a computed count) is better than typing the new value,
  if it is a small change. Otherwise edit the text, and say in the report
  which fact could be derived.
- When a count or name a test pins changed on purpose, update
  `website/src/lib/data/data.test.ts` with it.
- Site copy follows the repository's writing rules ([AGENTS.md](../../../AGENTS.md)):
  plain language, terms linked to the glossary, no origin references, no
  history in the copy.
- **Leave alone**: `noindex`, `robots.txt` and the "Internal preview"
  strip. Opening the site to search engines is a person's decision
  ([design/website.md § Build order](../../../design/website.md#build-order)).
  Copy whose new wording needs a person's judgement (what Jig claims, what it
  never does) goes in the report as a question, not into an edit.

**Follow-ups** are filed through the tracker the way `.config/jig.yaml`
says: `issue_tracker.file_command` with the `issue_tracker.labels.followup`
label, in `issue_tracker.team`. With no `file_command`, list them in the
report for a person to file. Each names the commits (short hashes and
subjects), what the site may now get wrong, which pages and files to look
at, and why this run deferred it. The record still advances past those
commits: the follow-up, not the record, keeps them open.

## Phase 4 — Record, then verify

Every file this run changes is edited before the checks run, so the checks
cover what is committed (the site renders `CHANGELOG.md` too).

1. `bun scripts/website-sync.ts --advance <target sha from Phase 1>`.
2. When a page changed in a way a reader notices, add a change note
   (`changes/website-update.md`, [changes/README.md](../../../changes/README.md))
   with one line under `### Changed` and no `release`; the release step
   writes it under Unreleased after the merge. No plugin version, no tag.
3. Verify. The site's build renders the audit example with the repository's
   own dependencies, so the root install comes first:

   ```sh
   bun install
   cd website && bun install --frozen-lockfile && bun run build && bun run check && cd ..
   bun run test ./website/
   rm -rf website/.astro website/dist
   JIG_GATES_SKIP_SEPARATE_SUITES=1 bun run gates
   ```

`bun run build` also runs the link check, which fails on a link to a missing
page or anchor. Fix what fails rather than suppressing it, then run the
checks again. For a change to how a page looks, open it with `bun run dev`
in `website/` and look at it in both themes.

## Phase 5 — Commit and open the pull request

1. Commit with a Conventional Commit: `fix(website): …` when the site was
   wrong or broken, `docs(website): …` when it only caught up, and
   `chore(website): site checked through <short sha>, nothing to change`
   when only the record moved. That last case still gets its pull request:
   it keeps the record honest and is cheap to review.
2. Push and open the pull request as a draft against `main`. Its body has:
   the range (`<base>..<target>`, commit count); a table of every reviewed
   commit with its verdict; how it was verified; the follow-ups filed; the
   questions for a person; and the line the repository asks for about the
   audit ("The audit: nothing changes, the site is not something
   `/jig:audit` scores", unless this run changed something it does score).
3. Offer to drive it with `/jig:drive-pr`. A person merges.

## Phase 6 — Report

End with, in this order:

- **Range**: from the recorded commit to the target, with the count of
  commits per kind.
- **Site edits**: each change and the commit that made it necessary.
- **Nothing needed**: the reviewed `content` commits, one line each.
- **Follow-ups**: each with its link, or "for a person to file" with its
  text.
- **For a person**: copy that needs a decision, and facts worth deriving
  instead of typing.
- **Pull request**: its link and state, and what was verified.
