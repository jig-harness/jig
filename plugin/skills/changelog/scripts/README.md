# The changelog scripts

The commands behind [`/jig:changelog`](../README.md): the branch check, the
release step and the status report. They read the repository's `changelog:`
section of `.config/jig.yaml` ([the configuration
reference](../../../CONFIGURATION.md#changelog)), so none takes the notes folder,
the changelog or the version files as a flag. Run them with Bun, with the
consumer repository as the working directory; they need no Jig checkout and no
dependencies, and are tested from a copy of the plugin
(`tools/plugin/plugin.test.ts`). A repository without `changelog.file` in its own
file gets `not configured` from each, and nothing is written.

Without a change note, each pull request would add its entry at the top of the
changelog's Unreleased section and, when it ships a release, bump the version.
Every merge would then put every other open pull request in conflict: the same
lines of the changelog, the same version field, often the same version number
claimed twice. With change notes, the pull requests touch disjoint files, and
the version is chosen once, on the integration branch, by one run at a time.

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
  change that ships in no release.
- Common Changelog adds one front-matter key, `authors: Jane Doe, John Roe`
  (or `[Jane Doe, John Roe]`; `[]` credits nobody), which replaces the authors
  taken from git.
- The sections are the format's change types: Keep a Changelog 1.1.0's `Added`,
  `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, or Common Changelog's
  `Changed`, `Added`, `Removed`, `Fixed`. A section lists its changes as top-level
  list items; in Common Changelog each is one line.
- A note holds only those sections, list items, paragraphs, inline links, code
  spans and emphasis. The note is parsed with Bun's Markdown parser
  (`Bun.markdown`) and every other element type is refused, wherever it sits: a
  code block, raw HTML (a comment included), a quote, a table, an image, a task
  list, a footnote, a heading that is not `###` with a change type of the format,
  and a line of only `=` or `-`, which makes the line above it a heading or a
  rule. Each could change how the changelog renders after the note. A parser is
  used because Markdown's block and inline rules interact (a code span cannot run
  from one list item into the next, an escaping backslash counts only as the last
  of a run), and a hand-written model of them is wrong at the edges. The text
  rules of `change-notes.ts` stay beside it, since the parser reports no source
  positions and reads inline HTML as text. It needs a Bun that ships
  `Bun.markdown`; any other fails with a message naming the version it needs
  (Jig pins 1.4.3).
- Text before the first section is the release's summary, so only a note with
  `release` may have one. No `#` or `##` heading: the step writes the version
  heading and its date.
- Links are relative to the note and written inline; the release step rewrites
  each relative link for the changelog's directory, leaving URLs, anchors,
  root-relative paths and links shown as code alone. A link's title is quoted
  with `"`, `'` or parentheses, and a destination holding a space or a
  parenthesis goes in `<…>`; a link the step could not rewrite is refused. So is
  a reference definition (`[label]: path`): every note's labels would share the
  changelog's one namespace.

## The release step

```sh
bun release.ts [--dry-run] [--json] [--date YYYY-MM-DD]
```

It reads every `*.md` directly in the notes directory but its README, in the
order the merges adding them landed on the branch's first-parent history (not
commit dates, which two merges can share and an author can set), and:

1. **Keep a Changelog.** With `unreleased: write`, writes each note without
   `release` into `## [Unreleased]`, appending to the change types already there
   and adding the missing ones in order. When any note has `release`, takes the
   largest bump from the current version, writes those notes as the new
   version's section below Unreleased (summaries first, in merge order), and
   moves the comparison links at the end of the file, if it has them: the new
   version's link compares it with the previous tag, or, for the first release,
   points at its own tag. With `unreleased: wait`, nothing is written until a
   note has `release`, and then all notes go into the new version's section.
2. **Common Changelog.** Nothing is written until a note has `release`; then all
   notes become one release above the newest the file lists, `**Breaking:**`
   entries first in each section, each entry ended by a reference to the change
   (a link to pull request 12, from its number in the subject of the commit that
   brought the note in, else the short hash) and its authors (the people who
   wrote the note's commits, never a bot, or the note's `authors:`), with a link
   definition for the version. The links come from the `origin` remote on GitHub
   or GitLab. A release has one notice: it refuses, naming the notes, when two
   waiting notes have a summary.
3. Sets the version in every version file, editing only the value at its key
   inside the key's own table, then parses the file again and checks that exactly
   that value changed. Files are JSON, TOML, YAML or a plain `VERSION` file;
   with `{ tags: true }` no file is written but the changelog.
4. Replaces each placeholder's `from` (one line) with its `to`, `{version}`
   filled in, in the files its globs match, never in a workflow.
5. Runs `after_version`, if set, from the repository root, after the files are
   written. It refuses to run inside a CI job (any of `CI`, `GITHUB_ACTIONS`,
   `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TF_BUILD` or `JENKINS_URL` set to
   something but `false` or `0`) unless the environment variable
   `JIG_AFTER_VERSION_IN_CI=1` says the job holds no secrets. Its output goes
   to standard error, it reads no input, and it is stopped after
   `JIG_AFTER_VERSION_TIMEOUT_SEC` seconds (1800 by default). A process it
   leaves running in the background when it returns is stopped, and the
   release fails (POSIX only).
6. Deletes the notes it wrote, last, so a failing `after_version` leaves them.

It computes every file before writing the first, and writes nothing when a note
is malformed, the version files disagree, a version cannot be set, two notices
compete, or several notes wait (or one, in Common Changelog, which credits the
people who wrote it) in a checkout without its whole history (a shallow clone,
or no git at all), where their merge order and authors cannot be told. Exit 0
written or nothing to write; 1 for a malformed note or a step that failed
(version files that disagree, `after_version`, no `origin` for Common Changelog
links); 2 for a usage error, an invalid configuration or an unreadable file. It
never commits, tags or pushes: the caller does, which keeps the token that may
push out of the script. Run it on the integration branch after every merge, one
run at a time (a CI concurrency group), always from the branch's newest commit,
so a run that waited writes whatever notes are left and no two runs pick the
same version.

Every waiting note is one release, even when several merges landed before the
run: the step releases the tree it runs on, which already holds all of their
code, so a version numbered and described for the earliest merge alone would
carry the later ones' changes (a breaking change under a patch number). A merge
that lands during a run is released by the run queued behind it.

`--json` prints `{ "plugin", "configured", "version", "previous", "notes",
"waiting", "stamped" }`; `version` is null when no note asked for a release,
`notes` are the notes written and `waiting` the notes left for a release.

## The branch check

```sh
bun check.ts [--base origin/main]
```

Every note must read the way the release step will read it. Against the merge
base with the base, a branch must also leave to the release step what only it
writes: the version files' versions, the changelog's Unreleased section and its
set of release sections. A branch that changes a `release_paths` prefix must add
or edit a note with `release`; one that changes a `note_paths` prefix must add or
edit a note. A path ending in `/` is a folder; one without is that file or folder
and what is under it, never a longer name that starts the same (`plugin` holds
`plugin/x`, not `plugin-docs/x`), and a file moved out of a path counts as a
change to it. In Common Changelog a `**Breaking:**` entry needs `release: major`
(`minor` before 1.0.0), a note whose commits are all by bots needs `authors:`, and
a summary is refused when a note waiting on the base has one. Correcting an
earlier release's text stays allowed: it is rare and touches lines no other
branch does; deleting the changelog is not. A note of an earlier branch that this
one changes or deletes is printed as a `note:` for the reviewer.

The check holds the branch to the `changelog:` section **the base holds**
(`git show <base>:.config/jig.yaml`), so a branch cannot unset `changelog.file`,
empty a path list or move the notes folder to pass its own check. A branch that
changes the section is also checked against the section it proposes, which must
parse and resolve, and the change is printed. Where the base holds no section
the check says `not configured`, even for the branch that adds one.

The base is `--base`; else, in a CI job, the base of the pull request that
started it (from the event, then `GITHUB_BASE_REF`); else the hosting service's
default branch (the event's `repository.default_branch` on a push, then
`origin/HEAD`, then `gh repo view`). It is never
`repository.base_branch` of the branch's own tree, which a pull request could
point at a weaker revision. A base git cannot compare against is a finding, so
the branch rules never pass by not running; only a clone with no remote at all,
whose own tree has no section, is taken for one that never adopted the skill. On the base itself only the notes are
checked, and the output says so. Exit 0 clean (or `not configured`), 1 findings,
2 a usage error.

## The status report

```sh
bun status.ts [--json]
```

The current version, the notes that ask for a release and the version they would
make, the notes that wait for a release (or that the next run writes under
Unreleased), and, when `origin` is on GitHub and `gh` answers, whether the last
release run on the integration branch (`repository.base_branch`, else the
default branch) succeeded; the run is the newest one of the workflow named
`release`, in any letter case (a workflow that only mentions the word, such as a
release-notes drafter, is not it). A host without an adapter, a missing or signed-out
`gh`, or an unreadable answer is reported as "unknown", never as a failure.
Exit 1 when a note is unreadable, the version files disagree or the last release
run failed; 2 for a usage error, an invalid configuration or an unreadable file.

Jig runs these on itself: `scripts/release.ts` from `.github/workflows/release.yml`,
and `scripts/check-changelog.ts` in `bun run gates`, both reading Jig's own
`changelog:` section. The self-tests are in [`../__tests__/`](../__tests__/).
The practice is
[M12's change records](https://github.com/docomply/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md).
