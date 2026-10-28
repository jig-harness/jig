# `/jig:changelog`: a changelog nobody has to merge by hand

A repository that keeps a [changelog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
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
check that a branch follows the rules and that the whole changelog follows its
format's, show what the next release will be, run
that release step and plan its tags, and a GitHub Action runs them in CI; its `SKILL.md` teaches an agent when a change needs a note
and how to write one worth reading. The practices are
[M12's change records](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md)
(no two pull requests edit the same lines) and
[M16, releases and versions](https://github.com/jig-harness/jig/blob/main/modules/M16-releases-versions/README.md)
(a changelog written for the people who use the released artifact, the
version chosen after the merge, a tag only on verified code).

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
does not say, an empty one included, is refused with a request to set it. A
Common Changelog file holds only its title and its releases, so it cannot say
which format it is in: a repository on that format sets `changelog.format`.

## Checking the whole changelog

The branch check reads the notes and what a branch changes; `lint.ts`
(`/jig:changelog lint`) reads the whole changelog against the rules of the
repository's format, and only those: `changelog.format`, else the format the
file names. A Common Changelog file is never held to Keep a Changelog's rules,
nor the other way round. Run it when the skill is set up on a repository with
an existing changelog, after a correction to an earlier release, and whenever
a person wants to know the file is well formed:

```sh
bun "<skill-dir>/scripts/lint.ts"
```

`--json` prints the findings as JSON instead. Each finding names the file, the line, the rule and what to change, ending
with the section of the format's specification that states the rule:

```text
CHANGELOG.md:28: [keep-a-changelog/date] the date "2023-02-29" of 1.0.1 is not a real day written year-month-day
  fix: write the release date as YYYY-MM-DD (Keep a Changelog 1.1.0, Confusing Dates: https://keepachangelog.com/en/1.1.0/#confusing-dates)
```

It exits 0 when the file follows its format's rules (or the skill is off), 1
with findings, and 2 on a usage error, an invalid configuration or an
unreadable changelog or one a link leads outside the repository, or when the
version files disagree, so coverage could
not be checked, and nothing else was found. In a GitHub Actions job each
finding is also an annotation on its line. The action runs it as
`command: lint`; the workflow template leaves it out of the pull-request
check, because some findings cannot be fixed by a pull request that the
branch check passes (a release section missing from the history: adding one
is the release step's). A repository that wants it in CI adds a job or a step
with `command: lint`, after `actions/checkout` with `fetch-depth: 0` so the
tags are there for the coverage rule.

Each rule is the specification's own, cited in the code at the rule; what the
specification leaves open, or only recommends, is not checked.

**[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).** Its rules
are its guiding principles and its answers, so a rule here is one of those.

| Rule | What it requires | Specification |
|------|------------------|---------------|
| `keep-a-changelog/title` | The file opens with a first-level heading | [the example changelog](https://keepachangelog.com/en/1.1.0/) |
| `keep-a-changelog/semver-statement` | The text above the first section says whether the project follows Semantic Versioning | [Guiding Principles](https://keepachangelog.com/en/1.1.0/#principles) |
| `keep-a-changelog/unreleased-first` | An `## [Unreleased]` section, where the file has one, comes first, and only once | [How can I reduce the effort…?](https://keepachangelog.com/en/1.1.0/#effort) |
| `keep-a-changelog/release-heading` | Every other `##` heading is `[version] - YYYY-MM-DD`, with ` [YANKED]` after the date for a pulled release | [Guiding Principles](https://keepachangelog.com/en/1.1.0/#principles), [What about yanked releases?](https://keepachangelog.com/en/1.1.0/#yanked) |
| `keep-a-changelog/date` | A release's date is written year-month-day and is a real day | [Confusing Dates](https://keepachangelog.com/en/1.1.0/#confusing-dates) |
| `keep-a-changelog/release-order` | The latest release comes first: no release is dated later than the one above it | [Guiding Principles](https://keepachangelog.com/en/1.1.0/#principles) |
| `keep-a-changelog/duplicate-release` | One section per version | [Guiding Principles](https://keepachangelog.com/en/1.1.0/#principles) (versions linkable) |
| `keep-a-changelog/change-type` | Every `###` heading is `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security` | [Types of changes](https://keepachangelog.com/en/1.1.0/#types) |
| `keep-a-changelog/grouped` | A type of change appears once per section | [Guiding Principles](https://keepachangelog.com/en/1.1.0/#principles) |
| `keep-a-changelog/version-link` | Each `[version]` heading has its link reference definition | [Guiding Principles](https://keepachangelog.com/en/1.1.0/#principles) |
| `keep-a-changelog/unreleased-link` | From the first release on, `[Unreleased]` links to the comparison of the newest release with `HEAD` | [Guiding Principles](https://keepachangelog.com/en/1.1.0/#principles) and the example changelog |
| `keep-a-changelog/coverage` | The version the version files hold, and every version a `<tag_prefix><version>` tag in the checkout's history names, has a section | [Guiding Principles](https://keepachangelog.com/en/1.1.0/#principles) |

Allowed, as the specification allows them: no Unreleased section, an
Unreleased section with no date, a `[YANKED]` release, the change types in
any order, text above a release's first group, and an `[Unreleased]` with no
link before the first release.

**[Common Changelog](https://common-changelog.org/).** Its rules are the ones
it states with "must".

| Rule | What it requires | Specification |
|------|------------------|---------------|
| `common-changelog/file-name` | The file is named `CHANGELOG.md` | [2.1. File format](https://common-changelog.org/#21-file-format) |
| `common-changelog/title` | The file starts with a first-level heading | [2.1. File format](https://common-changelog.org/#21-file-format) |
| `common-changelog/content` | After the title, nothing but releases (link reference definitions, which render as nothing, aside) | [2.1. File format](https://common-changelog.org/#21-file-format) |
| `common-changelog/no-unreleased` | No Unreleased section | [6.2. How is this different from Keep a Changelog?](https://common-changelog.org/#62-how-is-this-different-from-keep-a-changelog) |
| `common-changelog/release-heading` | Every `##` heading is `VERSION - DATE` (the version maybe a link), the version Semantic Versioning without a `v`, and no `[YANKED]` | [2.2. Release](https://common-changelog.org/#22-release) |
| `common-changelog/date` | A release's date is `YYYY-MM-DD` and a real day | [2.2. Release](https://common-changelog.org/#22-release) |
| `common-changelog/release-order` | Releases sorted latest first by Semantic Versioning precedence, one per version, whatever their dates | [2.1. File format](https://common-changelog.org/#21-file-format) |
| `common-changelog/version-link` | A version written as a link has its link reference definition | [2.2. Release](https://common-changelog.org/#22-release) |
| `common-changelog/release-content` | A release holds change groups, or a notice and then any number of them, and nothing else | [2.2. Release](https://common-changelog.org/#22-release) |
| `common-changelog/notice` | At most one notice, a single paragraph, per release | [2.3. Notice](https://common-changelog.org/#23-notice) |
| `common-changelog/category` | Every `###` heading is `Changed`, `Added`, `Removed` or `Fixed` | [2.4. Change group](https://common-changelog.org/#24-change-group) |
| `common-changelog/category-order` | The groups in that order, each once | [2.4. Change group](https://common-changelog.org/#24-change-group) |
| `common-changelog/change-list` | A group holds an unnumbered list and nothing else | [2.4. Change group](https://common-changelog.org/#24-change-group) |
| `common-changelog/reference` | Each change ends with a reference in parentheses that is a Markdown link | [2.4.2. References](https://common-changelog.org/#242-references) |
| `common-changelog/coverage` | The version the version files hold, and every version a tag in the checkout's history names, has a section, where it is a stable version | [2.1. File format](https://common-changelog.org/#21-file-format) |

Allowed, or not checked: a version without a link (it "should" link), a
change wrapped over several lines (it "should" be one), the place of breaking
changes in a group (they "should" come first), whether a change that breaks
something carries `**Breaking:**` (a file cannot show it), authors (a project
with one contributor may leave them out), a notice's count of sentences (a
sentence's end cannot be told from its punctuation), a pre-release without a
section, and a release heading whose tag does not exist yet (the release
step writes the heading before the tag, as the format asks).

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

## A branch that already edited the changelog

`convert.ts` turns a branch that edited the changelog or the version itself,
the way every branch did before the repository adopted change notes, into one
with a note: it moves the branch's entries into a note, puts back the integration
branch's open sections and version, and leaves the result uncommitted for its
owner to review. A branch stacked on another converts against that branch. The
agent skills use it where it helps: `resolve-conflicts` converts before merging
a branch whose changelog edits would conflict, so nothing resolved elsewhere is
thrown away.

## Setting it up

`/jig:changelog setup` walks you through turning the skill on in a repository
on GitHub, in steps, each checked before the next: the `changelog:`
section (and the changelog itself, from the
[Keep a Changelog](templates/keep-a-changelog.md) or
[Common Changelog](templates/common-changelog.md) template, when there is
none); a GitHub App created from a prefilled App manifest
([`direct`](templates/github/app-manifest-direct.json),
[`pull-request`](templates/github/app-manifest-pull-request.json)), installed
on the repository only, with its client ID and private key in a
`changelog-release` environment only the integration branch may use; the
branch rules the mode needs; the workflow; and the conversion of the pull
requests already open, each left for its owner. The agent changes no setting
itself: it tells you what to change and checks it after you did.

## How the release reaches the branch

`changelog.release.push` chooses one of two ways:

- **`direct`**: the App pushes the release commit onto the integration branch.
  The branch's ruleset lets the App past its rules, while a second ruleset,
  which does not name the App, keeps force pushes and deletion blocked for it
  too. Every merge is released at once, with no second merge.
- **`pull-request`**: no one passes the branch's rules. Every push to the
  integration branch regenerates a **release pull request** from scratch, and
  a person merges it. The branch check passes it only when re-running the
  release step on its merge base gives exactly its change; nobody edits it by
  hand, and a wording fix goes into the note through an ordinary pull request.

`release-access.ts` checks that the App can do what the mode needs and
nothing more, and setup runs it.

Either way, a version is tagged only once its **releasing commit**, the commit
on the integration branch that first carries its changelog heading, has passed
every required check: a publishing job started by the tag therefore ships
only a commit that passed. A check that was cancelled is run again once; a
releasing commit whose checks failed is left untagged, and `status.ts`
reports it. Only versions newer than the newest release tag on `origin` are
tagged, and with none yet only the newest, so adopting the workflow never
tags and publishes an untagged history.

## In CI: the action and the workflow

CI has no plugin installed, so the skill is also a GitHub Actions
[composite action](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
[`action.yml`](action.yml), used as
`uses: <jig-owner>/jig/plugin/skills/changelog@<commit> # v<version>`: the
full commit of a Jig release's tag, since a tag can move and a commit cannot.
It sets up Bun at the version Jig tests with and runs one command on the
checkout. Bun starts outside the checkout, in a folder of the runner's
temporary space holding its own empty settings, and is given the checkout's
path: so no file in the repository (`bunfig.toml`, `.env`, a `tsconfig.json`
whose `paths` could replace the script) changes what runs. In the `tag` job
the checkout keeps no credential; the action hands the token to the one git
call that reads `origin`'s tags.

| Input | For | What it is |
|-------|-----|------------|
| `command` | all | `check`, `lint`, `release` or `tag` (required) |
| `root` | all | the checkout, relative to the workspace (`.`) |
| `base` | `check` | the revision the branch is compared with; by default the pull request's base |
| `head-ref` | `check` | the branch the change comes from; by default the pull request's head |
| `rerun` | `tag` | `true` to run cancelled required checks again, once (needs Actions write); `false` by default |
| `token` | `check`, `tag` | the token GitHub is read with; the job's own token by default |
| `git-user-name`, `git-user-email` | `release` | who the release commit is by; `github-actions[bot]` by default |

| Output | For | What it is |
|--------|-----|------------|
| `changed` | `release` | `true` when the release step wrote something |
| `version` | `release` | the version released; empty when the notes went under Unreleased |
| `notes` | `release` | how many notes it wrote in |
| `start`, `commit` | `release` | the commit it ran on and the release commit on top of it |
| `bundle` | `release` | a git bundle holding that commit, for the job that pushes |
| `push`, `release-branch` | `release` | `changelog.release.push` and `changelog.release.branch` |
| `plan` | `tag` | the path of the tag plan as JSON |
| `ready` | `tag` | the versions that can be tagged now, `[{ tag, commit, message }]` |
| `failed` | `tag` | `true` when a releasing commit failed its checks |

The action never pushes, tags or opens a pull request. The workflow template,
[`templates/github/changelog.yml`](templates/github/changelog.yml), does,
in jobs that run nothing from the repository:

- `check`, on every pull request: the branch check. Make it a required check.
- `release`, on every push to the integration branch: the release step and
  `after_version`, in a job that holds no key; then `push`, the only job that
  can read the App's key besides `tag-push`, pushes the commit (`direct`) or
  the release branch and its pull request (`pull-request`).
- `tag-plan`, after each run of the workflows that report the required checks
  and every six hours, makes the tag plan and re-runs cancelled checks once;
  `tag-push` makes the tags it found ready.

Runs on the integration branch are never cancelled, so a release that waited
writes whatever notes are still there. Copy the template to
`.github/workflows/changelog.yml` and fill in the placeholders its header
lists; setup does both with you.

## The agents

Only where the repository turned the skill on, as its integration branch holds
the configuration: each asks first through a command that reads the base's
configuration rather than the branch's own (`check.ts`, or `bun "<skill-dir>/scripts/convert.ts" --dry-run` for `resolve-conflicts`, which converts before merging), so a
branch that predates the adoption is asked too.
`do-item` writes the note before it opens the pull request and runs the check
with the other gates; `drive-pr` and `resolve-review-comments` update the note in
the round whose accepted fix changes what it says; `resolve-conflicts` converts
before it merges; and Jig's own `/followup` reads `status.ts` to see that the
release run consumed the merged pull request's notes. A repository that did not
turn the skill on is never asked for a note.

## What it will not do

It keeps one changelog and one version per repository: a repository that
releases several artifacts at their own versions (a monorepo's packages)
needs a tool that keeps one per artifact, such as Changesets or
release-please
([M16's mappings](https://github.com/jig-harness/jig/blob/main/modules/M16-releases-versions/mappings.md#several-artifacts-in-one-repository)).
It does not publish anywhere (a GitHub Release, a package registry), or write
entries from commit messages (a commit subject is written for a reviewer, a note
for the changelog's reader). Its commands never commit, tag or push: in CI the
workflow does, in jobs that run nothing from the repository. Setup changes no
setting for you. CI providers other than GitHub can run the check and the
release step, but have no template yet.

The commands are `check.ts`, `lint.ts`, `status.ts`, `release.ts`, `convert.ts`, `tag.ts`
and `release-access.ts` in [`scripts/`](scripts/README.md), run with Bun from
the repository's root; each prints the plugin version it ran as. Their tests are in
[`__tests__/`](https://github.com/jig-harness/jig/tree/main/plugin/skills/changelog/__tests__).
