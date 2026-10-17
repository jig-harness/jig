# `/jig:changelog`: a changelog nobody has to merge by hand

A repository that keeps a [changelog](https://github.com/docomply/jig/blob/main/GLOSSARY.md)
and a version faces two bad options when many pull requests are open at once.
If each pull request edits the changelog and bumps the version itself, every
merge puts every other open pull request in conflict, and each conflict costs a
resolution and another full run of the checks. If nobody edits them until
release time, the changelog is written from memory and the release goes out late
or not at all.

This skill takes a third way. Each pull request adds a **change note**: a small
file of its own that says, for a reader of the changelog, what the pull request
changed and what release it needs. Pull requests then touch different files, so
they never conflict. After a merge, a release step writes the waiting notes into
the changelog, moves the version and deletes the notes. The skill's scripts
check that a branch follows the rules, show what the next release will be, and
run that release step; its `SKILL.md` teaches an agent when a change needs a note
and how to write one worth reading. The practice itself is
[M12's change records](https://github.com/docomply/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md).

## Turning it on

The skill is on in a repository whose **own** `.config/jig.yaml` sets
`changelog.file`. Nothing else turns it on: not a user file in `~/.jig/`, not an
environment variable (the commands refuse those and name where they were set).
Off, every command says `not configured` and does nothing, and the audit never
marks a repository down for not using it.

```yaml
changelog:
  file: CHANGELOG.md          # setting this turns the skill on
  release_paths: [src/]       # a change here ships only in a release: its note must ask for one
  note_paths: [docs/]         # a change here must carry a note, release or not
```

Everything else has a default; the
[configuration reference](../../CONFIGURATION.md#changelog) lists every field.
Because the branch check reads this section from the branch it compares with, a
pull request cannot weaken its own check by editing the section: the new section
takes effect with the merge that adds it.

## A note

```markdown
---
release: minor
---

### Added

- The `--json` flag prints the report as JSON.

### Fixed

- A missing configuration file is reported instead of crashing the command.
```

- `release` is `patch`, `minor` or `major`, judged from what the change does to
  someone who uses the released artifact. Leave the front matter out for a change
  that ships in no release.
- Each change is one list item under a change type: `Added`, `Changed`,
  `Deprecated`, `Removed`, `Fixed`, `Security` in Keep a Changelog; `Changed`,
  `Added`, `Removed`, `Fixed` in Common Changelog.
- A note holds only those headings, lists, paragraphs, links, code spans and
  emphasis. Anything that could change how the changelog renders after it (a
  code block, raw HTML, a quote, a table, an image) is refused, wherever it sits.

The full rules are in the [scripts reference](scripts/README.md) and
[`SKILL.md`](SKILL.md).

## Two formats

- **[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)**: an `Unreleased`
  section collects changes that ship in no release. `changelog.unreleased` says
  whether a note without a release is written there right after its merge
  (`write`, the default) or waits for the next release (`wait`, which saves a
  commit and a run of the checks per merge).
- **[Common Changelog](https://common-changelog.org/)**: no Unreleased section, so
  a note without a release waits for the next one. The release step adds what the
  format wants from the repository's own history, with no call to the hosting
  service: a link to the pull request (or the commit) and the authors. It never
  credits a bot; where a bot wrote the note, the note names the people with
  `authors:`. A release has a single one-sentence notice, so only one waiting
  note may carry a summary, and `**Breaking:**` entries need `release: major`
  (`minor` before 1.0.0). An entry must read the same once its reference is
  appended: a lone backtick in it would pair with the reference's, so the
  branch check refuses it.

When `changelog.format` is not set, the format is read from the file; a file that
does not say, an empty one included, is refused with a request to set it.

## Where the version lives

By default the release reads and writes the version from `package.json`,
`pyproject.toml` or `Cargo.toml`, wherever one sits at the repository root with
a written version. Or name the files (JSON, TOML, YAML or a plain `VERSION` file,
each with the key that holds the version), or keep the version only in git tags
(`version: { tags: true }`), as Go modules do. Only the one value changes; the
file's formatting and comments stay, and the file is parsed again to confirm
that nothing else moved. When the files disagree, or a key is ambiguous, nothing
is written.

Other files that repeat the version have two tools: a **placeholder** (a text such as
`since: next` that the release replaces with the version it makes, in the files
you name, never in a workflow), and `after_version`, a command of yours that
runs after the version changes, such as one that updates a lock file. Because
`after_version` runs your own command, it refuses to run inside a CI job unless
that job says it holds no secrets.

## What it will not do

It does not commit, tag or push, publish anywhere, or write entries from commit
messages (a commit subject is written for a reviewer, a note for the changelog's
reader). The workflow that runs the release in CI and the guided setup are later
steps of this skill's [design](https://github.com/docomply/jig/blob/main/design/changelog.md).

The commands are `check.ts`, `status.ts` and `release.ts` in
[`scripts/`](scripts/README.md), run with Bun from the repository's root; each
prints the plugin version it ran as. Their tests are in
[`__tests__/`](__tests__/).
