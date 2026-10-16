# Change notes

Keep a [changelog](../../../../GLOSSARY.md) and a version that every pull
request contributes to, without every pull request editing the same lines.
Each pull request adds a **change note**, a small file of its own; after the
merge, a release step writes the notes into the changelog, moves the version
when a note asks for it, and deletes the notes.

Without it, each pull request adds its entry at the top of the changelog's
Unreleased section and, when it ships a release, bumps the version. Every
merge then puts every other open pull request in conflict: the same lines of
the changelog, the same version field, often the same version number claimed
twice. With many agents working in parallel, each merge costs a conflict
resolution and a full CI run per open pull request. With change notes, the
pull requests touch disjoint files, and the version is chosen once, on the
integration branch, by one run at a time.

## A note

```markdown
---
release: minor
---

An optional summary of the release.

### Added

- One change per list item, written for the reader of the changelog.
```

- `release` is `patch`, `minor` or `major`. Leave the front matter out for a
  change that ships in no release: the note goes under `## [Unreleased]`.
- The sections are [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)'s
  change types: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
  `Security`. A section lists its changes as top-level list items.
- A note holds only those sections, list items, paragraphs, inline links,
  code spans and emphasis. The note is parsed with Bun's Markdown parser
  (`Bun.markdown`) and every other element type is refused, wherever it
  sits: a code block, raw HTML (a comment included), a quote, a table, an
  image, a task list, and a line of only `=` or `-`, which makes the line
  above it a heading or a rule. Each could change how the changelog renders
  after the note. A parser is used because Markdown's block and inline rules
  interact (a code span cannot run from one list item into the next, an
  escaping backslash counts only as the last of a run), and a hand-written
  model of them is wrong at the edges. It needs a Bun that ships
  `Bun.markdown` (Jig pins 1.4.3).
- Text before the first section is the release's summary, so only a note with
  `release` may have one. No `#` or `##` heading: the step writes the version
  heading and its date.
- Links are relative to the note and written inline; the release step
  rewrites each relative link for the changelog's directory, leaving URLs,
  anchors, root-relative paths and links shown as code alone. A link's title
  is quoted with `"`, `'` or parentheses, and a destination holding a space
  or a parenthesis goes in `<…>`; a link the step could not rewrite is
  refused. So is a reference definition (`[label]: path`): every note's
  labels would share the changelog's one namespace.

## The release step

```sh
bun release.ts --notes changes --changelog CHANGELOG.md \
  --version-file package.json [--version-file …] \
  [--stamp 'criteria/*.yaml' --stamp-from 'since: next' --stamp-to 'since: {version}'] \
  [--tag-prefix v] [--date YYYY-MM-DD] [--dry-run] [--json]
```

It reads every `*.md` directly in the notes directory but its README, in the
order the merges adding them landed on the branch's first-parent history
(not commit dates, which two merges can share and an author can set), and:

1. writes each note without `release` into `## [Unreleased]`, appending to
   the change types already there and adding the missing ones in order;
2. when any note has `release`, takes the largest bump from the version the
   version files agree on, writes those notes as the new version's section
   below Unreleased (summaries first, in merge order), sets `version` in every
   version file (editing only that value, so formatting survives), and moves
   the comparison links at the end of the changelog, if it has them;
3. replaces each `--stamp-from` placeholder (one line) in the files
   `--stamp` matches, for a file that must name the version a change ships
   in, which its branch cannot know;
4. deletes the notes.

It computes every file before writing the first, and writes nothing when a
note is malformed, the version files disagree, a version cannot be set, or
several notes wait in a checkout without its whole history (a shallow clone,
or no git at all), where their merge order cannot be told. It never commits, tags or pushes: the caller does, which keeps the
token that may push out of the script. Run it on the integration branch after
every merge, one run at a time (a CI concurrency group), always from the
branch's newest commit, so a run that waited writes whatever notes are left
and no two runs pick the same version.

Every waiting note is one release, even when several merges landed before the
run: the step releases the tree it runs on, which already holds all of their
code, so a version numbered and described for the earliest merge alone would
carry the later ones' changes (a breaking change under a patch number). A
merge that lands during a run is released by the run queued behind it.

`--json` prints `{ "version", "previous", "notes", "stamped" }`;
`version` is null when no note asked for a release.

## The branch check

```sh
bun check.ts --notes changes --changelog CHANGELOG.md \
  --version-file package.json [--release-path src/ …] [--base origin/main]
```

Every note must read the way the release step will read it. Against the merge
base with `--base`, a branch must also leave to the release step what only it
writes: the version files' `version`, the changelog's Unreleased section and
its set of release sections. A branch that changes a `--release-path` must
add or edit a note with `release`. Correcting an earlier release's text stays
allowed: it is rare and touches lines no other branch does; deleting the
changelog is not. Without `--base`, or on the base itself, only the notes are
checked, and the output says so; a `--base` git cannot compare against is a
finding, so the branch rules never pass by not running.
Exit 0 clean, 1 findings, 2 a usage error.

Both commands share `lib/` with the rest of Jig (`lib/cli.ts`,
`lib/guarded-git-spawn.ts`, `lib/record.ts`); vendor it beside them or run
them from a pinned Jig checkout. `change-notes.test.ts` is the self-test.
Jig runs both on itself: `scripts/release.ts` from
`.github/workflows/release.yml`, and `scripts/check-changelog.ts` in
`bun run gates`.
