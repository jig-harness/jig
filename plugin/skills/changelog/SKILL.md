---
name: changelog
description: "Keep a repository's changelog from change notes: write the note for a change, check a branch against the repository's changelog configuration, convert a branch that edited the changelog itself, see which release the waiting notes make. Applies only where .config/jig.yaml sets changelog.file."
argument-hint: "[note | check | status | convert]"
allowed-tools: "Read Write Edit Grep Glob Bash(bun *) Bash(git *)"
---

# Changelog: one change note per pull request

Many pull requests open at once cannot all edit the changelog and the version:
each merge would put every other pull request in conflict. So a pull request
adds a [change note](https://github.com/docomply/jig/blob/main/GLOSSARY.md),
a small file of its own, and a release step on the integration branch writes
the notes into the changelog, moves the version and deletes the notes after
the merge. This skill is the agent's side of that: when a change needs a note,
how to write one a reader of the changelog can use, and the commands that check
a branch and show what the next release will be. The practice is Jig's
[M12](https://github.com/docomply/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md);
the human's page is [README.md](README.md).

Jig maintains this procedure and ships it in the `jig` plugin. The repository
supplies its values in the `changelog:` section of its `.config/jig.yaml`
([configuration](#configuration)).

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository you are working on. Never
`cd` into the skill directory: the scripts find the repository and its
configuration from the working directory.

## When it applies

Only in a repository whose own `.config/jig.yaml` sets `changelog.file`. Find
out by running, from the repository root:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/status.ts"
```

It prints `not configured` where the skill is off. Then do nothing more: write
no note, run no other command of this skill, and never ask for a changelog
entry. A person's own `~/.jig/jig.yaml` or a `JIG__CHANGELOG__*` variable never
turns it on: the commands refuse those, naming where they were set. Where it is
on, `status.ts` also prints the notes waiting, the version they would make and
the notes that wait for a release, and each command prints the plugin version it
ran as.

## Writing a note

Write the note when you open the pull request, while the change is fresh, and
keep it true as review changes the change. Never edit the changelog's
Unreleased or release sections or any version file by hand: the release step
writes them, and the branch check fails a branch that does.

1. **Decide whether the change needs a note.** It does when the repository's
   `release_paths` or `note_paths` cover a file it changes (the branch check
   says so), and whenever someone who reads the changelog would want to know:
   a new capability, a changed behaviour, a fix to something a user hit, a
   removal. Skip it for a change that only the people working on the repository
   notice (a refactor, a test, a CI tweak) unless the check asks. A repository
   with neither path configured never requires a note.

2. **Create one file in the notes folder** (`changelog.notes_dir`, `changes`
   by default), named after the branch: its name with every character other
   than a letter, a digit, `.`, `_` or `-` replaced by `-` and cut to its first
   64 characters, then `-` and the first eight hexadecimal digits of the SHA-256 of the branch's full name
   (`printf %s "$branch" | shasum -a 256 | cut -c1-8`). The digits keep
   `feat/x` and `feat-x` apart. Only Markdown files directly in the folder are
   notes; its `README.md` is not one. If the branch already has a note, edit it.

3. **Judge `release` from what the change does to someone who uses the released
   artifact**, not from the size of the diff:

   | The change, for someone using the released artifact | `release` |
   |-----------------------------------------------------|-----------|
   | Breaks something they rely on: a removed or renamed feature, a changed default, a stricter check | `major` (`minor` before 1.0.0) |
   | Adds a capability or changes behaviour compatibly | `minor` |
   | Fixes a defect, or changes nothing they can observe | `patch` |
   | Ships in no release: nothing under the released paths changes | leave the front matter out |

   Put it in the front matter: a block of `key: value` lines between two `---`
   lines at the top of the file.

   ```markdown
   ---
   release: minor
   ---
   ```

   Several notes waiting are one release at the largest bump any asks for, so
   ask for what your change needs and no more.

4. **Write each change as one list item, for the reader of the changelog, not
   the reviewer of the diff.** Say what changed for them and where they meet
   it: the command, the option, the behaviour. One change, one item; two
   changes in the pull request, two items. Leave out file names, function names,
   pull request numbers and commit hashes (the release step adds the reference
   where the format has one). List the items under a `###` heading named for one
   of the format's change types:

   - Keep a Changelog: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
     `Security`.
   - Common Changelog: `Changed`, `Added`, `Removed`, `Fixed`. Write each entry
     in the imperative ("Add the retry option"), on one line.

   The release step puts the sections in the format's order, so write them in
   whichever order reads best.

5. **Mark a breaking change as the format marks it, and say what a consumer
   must change.** In Common Changelog start the item with `**Breaking:**`; the
   check then requires `release: major` (`minor` before 1.0.0). In Keep a
   Changelog write **Breaking** in the item. Either way, name the new spelling
   or the step to take: "**Breaking:** the `--out` flag is now `--output`;
   rename it in scripts."

6. **Add a summary only when it helps, and only with `release`.** Text before
   the first `###` section is the release's summary; a note without `release`
   may not have one. In Common Changelog it is the release's single notice, one
   sentence in one paragraph and in italics, and a release has only one: the
   check refuses it when a note waiting on the integration branch has one.

7. **Keep to the note's Markdown.** Headings `###` with a change type, lists
   and their items, paragraphs, and inline emphasis, links and code spans.
   Nothing else: no code block, raw HTML, quote, table, image, task list or
   reference-style link (`[text][label]` with a definition). Write a link inline
   with a path relative to the note, such as `../docs/guide.md`; the release
   step rewrites it for the changelog. Show code in a code span.

8. **Common Changelog only: authors.** The release step credits the people
   whose commits wrote the note, never a bot. When every commit that wrote the
   note is by a bot (an author name ending in `[bot]`), name the people in the
   front matter: `authors: Jane Doe, John Roe`. `changelog.authors: false`
   leaves authors out of the changelog.

9. **Run the check** with the repository's other gates before you push, and
   again when review changes what the pull request does:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/check.ts"
   ```

An example for a repository on Keep a Changelog:

```markdown
---
release: minor
---

### Added

- `jig config --json` prints every configured field with the file that set it.

### Fixed

- A repository without a `.config/jig.yaml` no longer stops `jig config` with a
  stack trace; it says the file is missing.
```

A branch that already edited the changelog or the version itself must put those
edits back to the integration branch's text and move the entries into a note:
[convert it](#converting-a-branch), never by hand.

## Converting a branch

When a branch edited the changelog's Unreleased or release sections or a version
file (the check says so), run, from the repository root with the work committed:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/convert.ts" --dry-run
bun "${CLAUDE_SKILL_DIR}/scripts/convert.ts"
```

The first prints what it would do. The second writes the branch's note (named
after the branch) from the release sections the branch added and its additions
to Unreleased, with the `release` of the bump the branch made to the version;
puts back the integration branch's open sections and version, keeping the
branch's edits to earlier releases; and sets a placeholder the branch filled
(`since: 1.3.0`) back to its text (`since: next`). It refuses during a stopped
merge, rebase or cherry-pick, on uncommitted changes and on a detached `HEAD`.
Its result stays uncommitted for you to review:

- read the note: it carries what the branch wrote, so reword an entry for the
  changelog's reader, and fix any line printed as `attention:`;
- look at each `check:` line, a line that still names the branch's version,
  which the script does not change;
- run `check.ts`, then commit.

A branch stacked on another pull request passes that branch as `--base`, so only
its own edits become its note. Where the repository has not turned the skill on,
the command says `not configured` and changes nothing.

## The commands

Each is a script in `${CLAUDE_SKILL_DIR}/scripts/`, run from the repository
root, and prints the plugin version it ran as.

| Command | What it does |
|---------|--------------|
| `check.ts [--base <ref>]` | The branch check. Every note reads as the release step will read it; the branch leaves the version and the changelog's open and release sections to the release step; a branch touching a release path carries a note that asks for a release, and one touching a note path carries a note; in Common Changelog also the format's rules (breaking entries, one-line entries, entries that read the same with their reference appended, one notice, authors). The base is `--base`, else the base of the pull request in a CI job, else the hosting service's default branch. It needs the full history. Exit 0 clean or `not configured`, 1 findings (a base that cannot be found included), 2 a usage error. |
| `status.ts [--json]` | The notes waiting, the version they would make, the notes that wait for a release, and on GitHub whether the last release run on the integration branch succeeded, a release run still going answering first (read through `gh`; without `gh`, or on another host, it says it could not read it). Exit 1 when a note is unreadable, the version files disagree or the last release run failed (the run is the one of the workflow named `release`). |
| `convert.ts [--base <ref>] [--dry-run] [--json]` | Turns a branch that edited the changelog or the version itself into one with a note ([§ Converting a branch](#converting-a-branch)). Exit 0 converted, nothing to convert or `not configured`; 1 a refusal; 2 a usage error. |
| `release.ts [--dry-run] [--json] [--date YYYY-MM-DD]` | The release step: writes the waiting notes into the changelog, moves the version, fills the placeholders, runs `after_version`, deletes the notes. Writes files only; it never commits, tags or pushes. CI runs it after a merge; run it yourself only with `--dry-run` to preview. Exit 1 for a malformed note or a step that failed (version files that disagree, `after_version`, no `origin` for Common Changelog links); 2 for a usage error, an invalid configuration or an unreadable file. |

The check holds a branch to the `changelog:` section **as the base holds it**,
not as the branch has it, so a pull request cannot weaken its own check. A
branch that edits the section is checked against the section it proposes as
well, which must be valid; the check prints the change as a `note:` line for the
reviewer. Where the base has no section, the check says `not configured`, even
on the branch that adds it.

## Configuration

The `changelog:` section of the repository's own `.config/jig.yaml`; every field
is documented, with its default, in the
[configuration reference](../../CONFIGURATION.md#changelog). `file` is the one
field that turns the skill on. Besides `file`: `format`, `notes_dir`, `version`,
`release_paths`, `note_paths`, `placeholders`, `after_version`, `unreleased`,
`authors`, `tag_prefix` and `release.push` / `release.branch`. The integration
branch is `repository.base_branch`, else the hosting service's default branch.

A **placeholder** is a text a file must hold before the release knows its
version (`since: next`): the release step replaces `from` with `to`, with
`{version}` filled in, in the files its `files` globs match, and never in a
workflow under `.github/workflows/`.

`after_version` is a command of the repository's, run after the version
changes and before the notes are deleted, for files that repeat the version (a
lock file). Its changes join the release. It does not run in a CI job (any of
`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TF_BUILD` or
`JENKINS_URL` set to something but `false` or `0`) unless the job sets
`JIG_AFTER_VERSION_IN_CI=1`: wiring that keeps it out of any job that can read
the key that pushes the release arrives with the CI step of this skill. Its
output goes to standard error, so `--json` output stays the report alone; it
reads no input, and after 30 minutes (`JIG_AFTER_VERSION_TIMEOUT_SEC` sets
the bound) it is stopped together with every process it started, which fails
the release with the notes still in place. A process it leaves running in the
background when it returns is stopped and fails the release too (not on
Windows), so wait for any background job inside the command.

## Formats

`changelog.format` is `keep-a-changelog` or `common-changelog`. When it is not
set, the format is detected: a file with an `## [Unreleased]` heading or a link
to keepachangelog.com is Keep a Changelog; one that links common-changelog.org
is Common Changelog; anything else, an empty file included, is refused with a
request to set the field.

- **Keep a Changelog.** Release headings are `## [x.y.z] - YYYY-MM-DD`.
  With `unreleased: write` (the default) a note without `release` goes under
  `## [Unreleased]` after its merge and notes with one become the new version;
  with `wait` it goes into the next release. Comparison links at the end of the
  file move on; the first release's link points at its tag.
- **Common Changelog.** No Unreleased section: a note without `release` waits in
  the notes folder, and `status.ts` lists it as waiting. A release lists
  `**Breaking:**` entries first in each section, ends each entry with a reference
  to the change and its authors, and gets a link definition. Sections go in the
  order Changed, Added, Removed, Fixed. The links come from the `origin` remote
  (GitHub and GitLab).

Earlier releases are never rewritten in either format.

## Versions

`changelog.version` says where the version lives: files, each `{ path, key }` in
JSON, TOML or YAML (or a plain `VERSION` file), or `{ tags: true }` for a
repository whose version is only its tags. Unset, it is derived from
`package.json` (`version`), `pyproject.toml` (`project.version`, else
`tool.poetry.version`) and `Cargo.toml` (`package.version`), each only where it
sits at the root and holds a written version. All files must agree. A file is
edited by replacing only the value at its key, inside the key's own table, then
parsed again to confirm; a key that is ambiguous, or an edit that changes
anything else, stops the release before anything is written. Versions are plain
`major.minor.patch`.

## What this skill does not do

It writes no entries from commit messages, publishes nothing, and does not
commit, tag or push; CI, the release workflow and setup are separate. Never
suppress the check: fix the note.
