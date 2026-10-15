# The `changelog` skill: design

**What problem this solves.** A repository that keeps a changelog and a
version faces two bad options when many pull requests are open at once. If
each pull request edits the changelog and the version itself, every merge
puts every other open pull request in conflict, and each conflict costs a
resolution and another full CI run. If nobody edits them until release time,
the changelog is written from memory and the release goes out late or not at
all. Jig solved this for itself: each pull request adds a
[change note](../GLOSSARY.md), and a release step on the integration branch
writes the notes into the changelog, moves the version and tags it after the
merge. Today that mechanism is a reference script inside
[M12](../modules/M12-parallel-agent-ergonomics/README.md) that an adopting
repository would have to copy and wire up by hand. With this built, a
repository turns it on with one section of its `.config/jig.yaml`, Jig's
agents write and keep the notes as part of their normal work, and a GitHub
Action and a guided setup take care of the check and the release.

This is the design of [ROADMAP.md](../ROADMAP.md) item 4. Built so far:

- the change-notes mechanism, as M12's
  [reference/change-notes/](../modules/M12-parallel-agent-ergonomics/reference/change-notes/README.md):
  the note format and its checker, the release step (`release.ts`, with one
  release per merge and version placeholders) and the branch check
  (`check.ts`), with their self-test;
- Jig's own use of it: `scripts/release.ts`, `scripts/check-changelog.ts`,
  `.github/workflows/release.yml`, the `jig-release`
  [GitHub App](../GLOSSARY.md), `main`'s [ruleset](../GLOSSARY.md) and the
  `release` environment
  ([ADR-0004](../docs/adr/ADR-0004-change-notes-released-after-the-merge.md));
- M12's audit criteria `change-records-one-file-per-change` and
  `change-records-assembled-after-merge`.

What is missing is everything that makes it usable by another repository:
the skill, its configuration, formats other than Keep a Changelog, version
sources other than JSON files, a way for CI to run it, a guided setup, and
the agent skills taking part. The questions that needed a person's decision
are settled ([§ Decisions this design needs](#decisions-this-design-needs)).

## How it works

### Opt-in

The skill is on in a repository whose own `.config/jig.yaml` sets
`changelog.file`. Every field of the section is `repository_only`, and the
skill reads the section from the repository layer alone: the shared reader
records which layer set each field (`configSource`), and a `changelog.*`
value from any other layer is refused, not merged. The merged view
`readOverlay` returns is not enough on its own, because the environment
layer (`JIG__CHANGELOG__FILE`) may override a `repository_only` field for
one run. So neither a person's own `~/.jig/jig.yaml` nor an environment
variable can switch the skill on, or change what it enforces, in a
repository that never adopted it.

Off, every part of it says so and does nothing: the branch check passes with
"not configured", the release step exits without writing, and `do-item`,
`drive-pr` and `resolve-review-comments` never ask for a note. The audit's
change-note criteria are expected-absent for a repository that keeps no
changelog or version that changes with its pull requests, so a repository is
never marked down for not using it.

### Where the code lives

The skill is `plugin/skills/changelog/`, with `SKILL.md` (the agent's
contract), `README.md` (the human's page), `scripts/`, `references/`,
`templates/`, `__tests__/` and `action.yml` ([§ How CI runs
it](#how-ci-runs-it)). Its scripts are M12's reference scripts, **moved**:
`reference/change-notes/` leaves M12 in the same pull request, M12's README,
`mappings.md` and `templates/WORKTREE-ERGONOMICS.md` link to the skill
instead, and Jig's own `scripts/release.ts` and `scripts/check-changelog.ts`
import the skill's scripts, the way `scripts/check-workflow-conventions.ts`
imports M13's lint.

The plugin runs from a cache copy that has neither Jig's `lib/` nor
`node_modules`, so the moved scripts stop importing `lib/`. One of its
helpers has no plugin-side equivalent and moves into the plugin's shared
code: the guarded synchronous spawn (`lib/guarded-git-spawn.ts`). It does
not clean the environment itself: it refuses to run unless its caller passes
an explicit environment free of the git variables a hook exports (`GIT_DIR`,
`GIT_INDEX_FILE`, …, its `LEAKY_GIT_ENV`). Each moved script therefore
builds that environment, as the reference's `notes-dir.ts` does today, so a
branch check run from a hook reads the repository it was asked about. It
goes to `plugin/shared/`, the directory [ROADMAP.md](../ROADMAP.md) item 5
creates for code several skills share, so its path changes once. If this is
built before item 5, its first step creates `plugin/shared/` with only this
file, and item 5 adds the rest.

The command-line boundary does not move. The reference's `lib/cli.ts`
`cli()` maps a thrown error to exit 2; the plugin's
`resolve-review-comments/scripts/lib/cli.ts` already has `runMain()`, which
maps an `ExitError` to its own code and any other error to exit 1. The moved
scripts use `runMain()` and raise an invalid input as `fail(2, …)`, so an
invalid input still exits 2 and nothing that failed exits 0; item 5 then
has one boundary to move, not two. The vendored YAML parser, the
configuration reader and `runMain()` are used by sibling path, as other
skills use them today.

### Configuration

Read through the shared reader, documented in
[CONFIGURATION.md](../plugin/CONFIGURATION.md) and listed in the audit's
`config-schema.yaml` in the same pull request:

| Field | Default | Meaning |
|-------|---------|---------|
| `changelog.file` | required | The changelog, relative to the repository root. Setting it turns the skill on. |
| `changelog.format` | detected | `keep-a-changelog` or `common-changelog` ([§ Formats](#formats)). |
| `changelog.notes_dir` | `changes` | The folder of change notes. |
| `changelog.version` | derived | Where the released version lives ([§ Versions](#versions)). |
| `changelog.release_paths` | `[]` | Path prefixes whose change ships only in a release: a branch touching one must carry a note that asks for a release. |
| `changelog.note_paths` | `[]` | Path prefixes whose change must carry a note, with or without a release. |
| `changelog.placeholders` | `[]` | Version placeholders to fill at release, each `{ files, from, to }` with `{version}` in `to`, as Jig's `since: next`. A pattern that matches a file under `.github/workflows/` is refused. |
| `changelog.after_version` | none | A command the release step runs after it changes the version, before it commits, for files that repeat the version (a lock file: `npm install --package-lock-only`, `cargo update --workspace`, `uv lock`). Its changes go into the release commit. It runs in the job that holds no key ([§ How the release reaches the branch](#how-the-release-reaches-the-branch)). |
| `changelog.unreleased` | `write` (`wait` in `pull-request` mode) | Keep a Changelog only: whether a note without `release` is written under Unreleased after its own merge (`write`) or waits for the next release (`wait`), which saves a commit and a CI run per merge. `pull-request` mode refuses `write`: it opens a pull request only for a release. |
| `changelog.authors` | `true` | Common Changelog only: `false` leaves authors out, as the format allows for a project with one contributor. |
| `changelog.tag_prefix` | `v` | What a version's tag puts before it. |
| `changelog.release.push` | `direct` | `direct` or `pull-request` ([§ How the release reaches the branch](#how-the-release-reaches-the-branch)). |
| `changelog.release.branch` | `changelog-release` | `pull-request` mode: the branch the release pull request comes from. |

The integration branch is derived, as the other skills derive it: the
existing `repository.base_branch` field when a repository sets it, otherwise
the hosting service's default branch (in CI, from the event that started the
job; locally, from `origin/HEAD`, then `gh repo view`). The skill adds no
field of its own for it.

What the branch check requires follows only from `release_paths` and
`note_paths`. With both empty, the default, a note is never required and a
branch may add one to say what it changed. Whether a pull request "changes
what users see" is a judgment, so the agents make it ([§ The agent
skills](#the-agent-skills)); the check enforces only what the repository
configured. Jig's own configuration sets `release_paths: [plugin/]`.

The branch check enforces the configuration the integration branch holds,
not the branch's own: it reads the `changelog:` section from
`.config/jig.yaml` at the base it compares against (`git show
<base>:.config/jig.yaml`), so a pull request cannot unset `changelog.file`,
empty `release_paths` or `note_paths`, or move the notes folder to pass its
own check. A branch that changes the section itself is checked as well
against the section it proposes, which must parse and validate, and the check
names the change so the reviewer sees it. The comparison base comes from a
source the branch cannot change: in CI, the base of the pull-request event
that started the job; locally, `--base` or the hosting service's default
branch. It never comes from `repository.base_branch` in the branch's own
working tree, which the derivation above reads, since a pull request could
point that field at a ref whose `changelog:` section is weaker. Where the base holds no `changelog:` section, the check
reports "not configured" even when the branch adds one: the skill turns on
with the merge that adds it.

### A note

The note format stays as M12's reference defines it: optional
[front matter](../GLOSSARY.md) whose only key is `release: patch|minor|major`
(Common Changelog adds `authors:`), an optional summary, then
`###` sections of list items. The section names and their order follow the
configured format: Keep a Changelog's `Added`, `Changed`, `Deprecated`,
`Removed`, `Fixed`, `Security`, or Common Changelog's `Changed`, `Added`,
`Removed`, `Fixed`. A note's file name is the branch's name with every
character other than a letter, a digit, `.`, `_` or `-` replaced by `-`,
followed by the first eight hexadecimal digits of the SHA-256 of the
branch's full name, directly in the notes folder: `feat/x` and `feat-x`
then give different files, and no branch name gives the folder's own
`README.md`, which the release step never reads as a note. A branch may
change or delete a note it did not add, as a wording fix to a note waiting
for its release does, and the branch check names every such note so the
reviewer sees it.

The checker keeps its text rules, which see what a Markdown renderer hides:
raw HTML inline or in a block (a comment included), reference definitions,
and every link's destination, which the release step rewrites for the
changelog's folder. Bun's built-in renderer, `Bun.markdown.render`, is added
as a second, structural check: the front matter is removed first, then
every block element the renderer reports must be on an allow-list
(`###` headings with a known section name, lists and their items,
paragraphs) and every inline one too (emphasis, links, code spans, text).
That catches what the text rules approximate, such as where a list item ends
or whether a backslash escapes. The renderer reports no source positions and
reports inline HTML as text, so it never replaces the text rules. Jig pins
Bun 1.4.3, which has `Bun.markdown`; a Bun without it fails the check with a
message naming the version it needs.

### The commands

Each is a script under `scripts/`, run by the agent through the skill or by
CI through the action, with the repository as the working directory. Each
prints the plugin version it ran as.

| Command | What it does |
|---------|--------------|
| `check.ts [--base <ref>]` | The branch check: every note reads; the branch leaves the version and the changelog's open and release sections to the release step; a branch touching a release path carries a note that asks for one, and one touching a note path carries a note. The base defaults to the integration branch; a base git cannot compare against is a finding, never a skipped check. It needs the full history (`fetch-depth: 0` in CI). |
| `release.ts [--dry-run] [--json] [--date YYYY-MM-DD]` | The release step: writes the waiting notes into the changelog, moves the version, fills the placeholders, runs `after_version`, deletes the notes. Writes files only; never commits, tags or pushes. |
| `convert.ts` | Turns a branch that edited the changelog or the version itself into one with a note ([§ Converting a branch](#converting-a-branch)). |
| `status.ts` | The waiting notes, the version they would make and the notes that wait for a release. On GitHub it also reads whether the last release run on the integration branch succeeded (through `gh`). |
| `release-access.ts` | Whether the release can reach the integration branch in the configured mode, and force pushes and deletion stay blocked for the release identity too ([§ Setup](#setup)). Reads GitHub's rulesets and branch protection. |

The agent writes a note by hand from the procedure in `SKILL.md` (§ Writing
a note): what changed, for the reader of the changelog rather than the
reviewer of the diff; one list item per change; a breaking change marked as
the format marks it, with what a consumer must change; and the `release`
the change needs, judged from what it does to someone who uses the released
artifact. This is the "draft entries" of the roadmap item, moved from
release time to the moment the pull request opens, when the change is best
understood. No script writes the prose.

### Formats

`changelog.format` is detected when it is not set: a file with an
`## [Unreleased]` heading, or one that links keepachangelog.com, is Keep a
Changelog; one that links common-changelog.org is Common Changelog. Anything
else, an empty file included, is refused with a request to set the field.
A missing file is created by setup from the format's own template.
The release step writes release headings as `## [x.y.z] - YYYY-MM-DD`, with
a link definition for the version. It reads that form in both formats, and
in Common Changelog also the unlinked `## x.y.z - YYYY-MM-DD` the format
allows; any other heading is left to the format check of roadmap item 4,
not guessed at here.

**Keep a Changelog.** As Jig's own: notes without `release` go under
`## [Unreleased]` (when `unreleased` is `write`, after their own merge;
otherwise with the next release); notes with one become the new version's
section with its date. When the file ends with comparison links (links
that show what changed between two tags on the hosting service), the
step moves Unreleased's link past the new version and adds the version's
own, comparing it with the previous tag; for the first release, which has
no previous tag, the version's link points at its tag
(`releases/tag/<tag>`).

**Common Changelog.** There is no Unreleased section: a note without
`release` waits in the notes folder and goes into the next release, and
`status.ts` lists it as waiting rather than as a failed release. The release
step adds to each entry what the format requires and the repository's own
history holds, without asking the hosting service: a reference to the
change (the pull request number from the subject of the commit that brought
the note to the integration branch, written `(#n)` by a squash merge and
`Merge pull request #n from …` by a merge commit, or that commit's short hash
when it names none, linked through the `origin` remote's address) and its
authors (the authors of the commits that added and changed the note,
followed through the merge; a note's front matter may name them instead with
`authors:`). A bot is never credited: the format credits the person who
merged a bot's change, which the repository's history does not record, so
the branch check requires `authors:` on a note whose commits are all by
bots (an author whose name ends in `[bot]`). A
repository with one contributor may leave authors out, as the format
allows, with `changelog.authors: false`. Common Changelog gives a release
one notice, a single sentence; the note's summary is that notice, so the
branch check refuses a summary when a note already waiting on the base has
one, and the release step refuses, naming the notes, when two waiting notes
have one. It lists entries that start with `**Breaking:**` first in their
section, and adds a link definition for the new version. The branch check
adds the format's rules for a note that a script can check: each entry is
one line, and a `**Breaking:**` entry requires `release: major` (or `minor`
before 1.0.0).
Writing entries in the imperative is a rule of the procedure, which the
reviewer checks; no script judges grammar.

The release step never rewrites an earlier release in either format.
Checking a whole changelog (structure, category order, dates, link
references) stays the separate check of roadmap item 4.

### Versions

`changelog.version` says where the released version lives:

- **Files** (the default): `{ files: [{ path, key }] }`. Derived when unset:
  `package.json` (`version`), `pyproject.toml` (`project.version`, else
  `tool.poetry.version`) and `Cargo.toml` (`package.version`), each only
  when present at the root and holding a written version at that key. A
  version computed at build time (`dynamic = ["version"]`), inherited from a
  workspace (`version.workspace = true`) or absent (a monorepo's root
  `package.json`) is not derived, and with no file left the setup asks for
  the field. All files must agree before a release.
- **Tags**: `{ tags: true }`, for a repository whose version is only its tags
  (Go modules, for one). The release writes no file but the changelog, so
  the current version is the changelog's newest release heading, which the
  release commit writes at once; the tag follows after verification
  ([§ Tagging after verification](#how-the-release-reaches-the-branch)). A
  second release run before the tag exists therefore still counts from the
  version the first one wrote. Before the first release, the current version
  is the highest `<tag_prefix>x.y.z` tag, or `0.0.0`.

A version file is edited by changing only the value at the key, inside that
key's own table or object (a TOML `[package]` table's `version`, not a
dependency's), then parsing the result to check that exactly that value
changed (`JSON.parse`, `Bun.TOML.parse`, the vendored YAML parser; a
`VERSION` file holds the version alone). Formatting, comments and key order
survive. A file where the key is ambiguous, or whose parsed value does not
change to the new version, stops the release before anything is written.
Other files that repeat the version, lock files above all, are
`after_version`'s to update.

Versions are plain `major.minor.patch`; pre-release versions and calendar
versions are left out ([§ Left out](#left-out)).

### Releasing several merges at once

The release run is serialized and starts right after each merge, so it
usually finds one merge's notes. When several merges are waiting (a run
failed, or merges landed while one was running), the reference writes one
version per merge, each a commit and a tag of its own. Each of those tags
points at a commit whose tree already holds every waiting merge, so an
earlier tag can carry a later merge's change under the earlier merge's
version, a breaking change under a patch version included.

A release run therefore releases **everything waiting as one version**: the
largest bump any waiting note asks for, all their entries, one commit, one
tag, so every tag names exactly the tree it points at. Two merges caught in
one run then share a version. Building each merge's tag from its own tree
instead would put release commits beside the integration branch rather than
on it. A person ruled this way on 2026-10-15. It reverses what
[ADR-0002](../docs/adr/ADR-0002-the-plugin-is-its-directory.md) rejected
("release only now and then, batching changes") and changes
[ADR-0004](../docs/adr/ADR-0004-change-notes-released-after-the-merge.md)'s
decision, so build step 3 amends both. The amendment to ADR-0002 states that
the release versions already reached consumers together: each merge lands
on the integration branch first, and a run that found several pushed all
their release commits and tags in one atomic push.

### How the release reaches the branch

The release step's commit goes to the integration branch after the merge, so
an identity must be allowed to write it. A push made with the workflow's own
`GITHUB_TOKEN` starts no other workflow, so the release commit would get no
CI and its tag would start no publishing job: both modes therefore act as a
GitHub App, with a token minted for the run from a key kept in a
[deployment environment](../GLOSSARY.md) that only the integration branch
may use. The App gets Contents read and write (and, in `pull-request` mode,
Pull requests read and write), never Workflows, so a release commit cannot
change a workflow. The release runs in two jobs: the first runs the release
step and `after_version` with no access to the environment and passes its
commit on as an artifact; the second, which alone may read the key, pushes
that commit and runs nothing from the repository.

- **`direct`** (Jig's own setup): the release workflow pushes the release
  commit. The branch's ruleset lets the App past its rules. This is the
  exception [M10](../modules/M10-environments-deploy/README.md#release-state-off-the-source-line)
  makes for a machine identity, but on the shared integration branch rather
  than on a ref of its own, so it is narrowed further: the App can change
  contents only, its key is held by the environment, and the workflow that
  uses it changes only through a reviewed pull request. Notes without a
  release, under `unreleased: write`, get a commit of their own.
- **`pull-request`**: no actor passes the branch's rules. On every push to
  the integration branch that leaves a note asking for a release, the
  release workflow regenerates `changelog.release.branch` from scratch:
  it runs the release step on the integration branch's tip, dated that day,
  commits, force-pushes the release branch, and opens the release pull
  request or updates it. Notes merged while it is open are in its next
  regeneration, and nobody edits the branch by hand: a wording fix goes in
  the note, through an ordinary pull request. A person merges it. The branch
  check passes a release pull request when re-running the release step on
  its merge base, with the date of the branch's new release heading and the
  same pinned plugin version, gives exactly the branch's change, apart from
  the files `after_version` changed, whose output can depend on what a
  package registry answers that day; those must change only where they
  repeat the version.

**Tagging after verification.** In both modes a version is tagged on the
commit that released it and on no other: the first commit on the integration
branch's first-parent line (its own history, without the commits of the
branches merged into it) whose changelog has that version's heading. However
the release reached the branch (a squash, a merge commit, a rebase, a direct
push), that commit holds exactly the release. The `tag` job runs after every
check run completes on the integration branch, finds each version that has a
heading but no tag, and tags its releasing commit once every required check
on that commit itself has passed: the required checks are the ones the
branch's rules require, or the repository's `ci.required_checks`, not one
named workflow. A later commit's success never stands in for the releasing
commit's. A releasing commit whose required checks were cancelled rather
than failed (a gate workflow that cancels its earlier runs on the
integration branch when a newer push arrives, as Jig's does today) gets those
checks run again once, by the `tag` job; the workflow template's own checks
do not cancel runs on the integration branch. A releasing commit whose checks
failed is reported by `status.ts` and left untagged for a person. The re-run
needs Actions write, which the App is never given: the `tag` job runs it
with its own `GITHUB_TOKEN`, granted `actions: write` in that job alone
(the workflow's default stays `contents: read`), and the template and setup
both say so. The same job reads the required checks with that token, which
is also granted `checks: read` and `statuses: read`, since a required check
can be a check run from outside Actions or a commit status, and a scope an
explicit `permissions:` block leaves out is `none`. A
publishing job that starts on a new tag therefore only ever ships a commit
that passed its checks. A machine that installs from the integration branch
receives a release as soon as its commit lands; a machine pinned to a tag
receives it once the tag exists.

### How CI runs it

CI has no plugin installed, and the plugin commits nothing into a
repository. The skill therefore ships as a
[composite action](../GLOSSARY.md) as well: `action.yml` at the skill's root,
used as `uses: <jig-owner>/jig/plugin/skills/changelog@<commit-sha> # v<version>`,
with an input naming the command (`check`, `release`, `tag`). The pin is the
full commit hash of the release's tag, since a tag can be moved and a hash
cannot, with the version as a comment. GitHub fetches the action at that
commit, so the scripts and their version arrive with no separate checkout
and no token. Renovate and Dependabot move the hash and its comment like any
other action's, once each can read the private repository: Dependabot
through the organization's settings (Code security → Dependabot), Renovate
through its app's access to Jig. The action
sets up Bun at the version it was tested with. Jig's own workflow uses the
action from its own checkout (`uses: ./plugin/skills/changelog`), so Jig
always runs the version being changed.

While Jig's repository is private, a repository in the same organization can
use the action once Jig's settings allow its actions to be used from the
organization's repositories (Settings → Actions → Access). That setting, and
whether repositories outside the organization can use it at all (which needs
Jig published), are a person's decisions
([AGENTS.md](../AGENTS.md), HITL decisions).

CI is the authority: the agent's local run uses whatever plugin version its
machine has installed and may disagree with the pinned one; the check prints
the version it ran as, so a disagreement is visible. A repository's own gate
command need not run the check, because the action does.

**Templates.** `templates/github/changelog.yml`: the branch check as a job
for pull requests, the release on pushes to the integration branch in the
configured mode, and the `tag` job. GitLab's and other providers' equivalents
stay on the roadmap item until a repository needs one. `check.ts`,
`release.ts` and `convert.ts` read only git and the repository's files, so
any provider's CI can run them. `status.ts`'s run lookup, `release-access.ts`
and setup read GitHub (its runs, rulesets and branch protection), each
behind its own adapter; another provider adds its adapters beside them.

### Setup

`/jig:changelog setup` walks a person through what only a person can do, in
order, checking each step before the next. It changes no repository or
organization setting itself; it prints what to change and checks it after:

1. write the `changelog:` section, with the derived values shown for
   confirmation, and create the changelog from the format's template when
   the repository has none;
2. create the App from a prefilled
   [App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
   with the permissions the mode needs, install it on the repository only,
   create the environment restricted to the integration branch, and store
   the App's client ID and private key there;
3. for `direct` mode, protect the integration branch with two rulesets. One
   carries its current rules except force-push and deletion protection, and
   adds the App as a bypass actor, keeping any bypass it already had
   (administrators', for one). The other blocks force pushes and deletion
   only, with no bypass actor that is not already allowed past them, since a
   bypass actor passes every rule of the ruleset that names it. The rulesets
   are created first and the old branch protection removed after, so the
   branch is never unprotected; until it is removed, both apply and the App
   cannot pass.
   Setup stops with an explanation when an organization ruleset also covers
   the branch, which a repository ruleset's bypass cannot pass, or when the
   plan does not offer rulesets or environments for a private repository;
4. add the workflow from the template;
5. convert the pull requests already open ([§ Converting a
   branch](#converting-a-branch)), each left for its owner to review.

`release-access.ts` checks only what the release needs, by mode. In
`direct` mode, the chosen identity can bypass every rule that would stop
the release's ordinary push to the integration branch, such as a required
pull request or required checks (`always`, not only for pull requests),
while the force-push and deletion rules stay binding for it. In `pull-request` mode, no
bypass is asked for: the identity can push `changelog.release.branch` and
open a pull request from it, and no rule on that branch stops the
regeneration's force push. In both, it checks the force-push and deletion
rules as they apply to the release identity, not only that such rules
exist: a ruleset that blocks them but lists the identity as a bypass actor
does not block them for it. It reads every
page of the branch's rules, combines several rulesets with any classic
branch protection the way GitHub applies them (the most restrictive setting
wins), and reports "unknown" where GitHub withholds a ruleset's bypass list
from the token reading it. Jig's own `scripts/check-branch-protection.ts`,
which checks Jig's whole branch policy, stays Jig's and takes the same
reading of rulesets from this script.

### Converting a branch

`convert.ts` turns a branch that edited the changelog or the version itself
into one with a note, against its merge base with the integration branch:

1. it refuses during a merge, rebase or cherry-pick that has stopped, and on
   uncommitted changes;
2. it takes the release sections the branch added and its additions to
   Unreleased, writes them as one note, and rewrites each relative link from
   the changelog's folder to the notes folder;
3. the note's `release` is the bump from the merge base's version to the
   branch's (none when the branch did not move it);
4. it puts back the merge base's Unreleased section, release sections and
   version, and keeps the branch's edits to earlier releases;
5. a placeholder value the branch added (a configured `to` filled with the
   version the branch set) goes back to its `from`; any other line naming
   that version is listed for a person to check, not changed;
6. it leaves the result uncommitted, with a summary, for review.

`resolve-conflicts` uses it before merging, not after: when the branch edits
the changelog's open sections or a version that the base has also changed,
it converts the branch and commits first, and then merges, so those files
cannot conflict and no resolution made to another file is thrown away.

### The agent skills

Only where the repository has opted in:

- **`do-item`** writes the change note before it opens the pull request,
  when the change is one the repository's readers would notice or a
  configured path requires one, and runs `check.ts` with the other gates.
- **`drive-pr` and `resolve-review-comments`**: when an accepted fix changes
  what the note says the pull request does, the same round updates the note.
- **`resolve-conflicts`** converts rather than merges the changelog and the
  version files ([§ Converting a branch](#converting-a-branch)).
- **`/followup`** (Jig's own) checks, with `status.ts`, that the release run
  for the inspected merge consumed that merge's notes, rather than reading
  any note on the branch as a failed release.

### Where the practice lives

M12 keeps what is about parallel work: no pull request edits a file every
pull request edits, so change records are one file per change, written in
after the merge. Its change-record criteria stay and name the skill as the
remedy.

The rest is release practice: a changelog per released artifact, the version
chosen once after the merge, a tag per release made from verified code, and
the release identity let through the branch's rules. M10 holds the
post-merge pipeline, but it treats a library's release as gated elsewhere
and its deploy criteria as expected-absent for a library, while libraries
are the repositories that most need a changelog. The practice therefore gets
a module of its own for releases and versions, M16 (M15 is planned for
contracts). M10 applies to a repository that deploys, M16 to one that
publishes versioned software for others to download, embed or consume, such
as a library, a tool, or a service's client library or downloadable build. A
repository can do both, and then both apply. M16's criteria are
expected-absent for a repository that publishes no versioned artifact, not
for every deployed service, and M10's note that a library's release is
gated elsewhere points at M16.

M16 states the release-tag rule itself: each version's tag is made on the
commit that released it, once that commit's own required checks pass
([§ Tagging after verification](#how-the-release-reaches-the-branch)). M10's
verified pointer is a different thing, a ref that advances after
verification to record what runs, and M10 does not require a tag per
version. The machine identity let past the branch's rules is M10's
exception, stated once there and linked from M16. M10's rule that a release
pointer stays a pure fast-forward of verified source governs that pointer,
not the integration branch, so a release step that commits to the
integration branch does not conflict with it. The two must be different
refs, and M16 says so: the release commit reaches the integration branch
before its own checks pass, which a pointer that may advance only to
verified source cannot allow. A repository whose integration branch is that
pointer moves the pointer to a ref of its own before it adopts the skill.

## Decisions this design needs

Each is settled by a person before the build step that depends on it. Each
is framed, with the options and a decision sheet, on the tracker issue
linked from the pull request that added this design, where its ruling is
recorded. Every decision below is settled.

1. **Settled 2026-10-15: one version for everything a release run finds**,
   amending ADR-0002 and ADR-0004
   ([§ Releasing several merges at once](#releasing-several-merges-at-once)).
   It concerns `direct` mode only: in `pull-request` mode one release pull
   request carries everything waiting whatever is decided. The alternative is
   keeping one version per merge and accepting tags whose tree holds later
   changes. It happens: in Jig's first day of releases, one run found three
   merges and made 0.32.0, 0.32.1 and 0.33.0, each tag on a tree holding all
   three. Tagging after verification does not change how often it happens,
   since the release still runs right after each merge; only the tags come
   later. One version per merge also cannot pass the tag rule: a run's
   intermediate release commits get no CI run of their own. The reference's
   per-merge mode then has no user left, and build step 3 deletes it unless
   a person asks to keep it.
2. **Settled 2026-10-15: a new module for releases and versions**, M16,
   rather than M10 widened
   ([§ Where the practice lives](#where-the-practice-lives)).
   Releases and versions matter for software that is downloaded, embedded or
   consumed (libraries, tools); deploys and their pointers matter for a
   deployed service. The audit already marks M10's deploy criteria
   expected-absent for a library, which publishes rather than deploys; a
   repository that does both has both modules apply. A new
   module costs a number and a row in the module map, the profiles, the
   audit's methodology and criteria, and the website, and puts another module
   in front of a reader (M16, since M15 is planned for contracts); widening
   M10 costs its focus on deploys and
   an exception in its expected-absent rule for libraries. M12 keeps the
   one-file-per-change part either way. Blocks build step 6.
3. **Settled 2026-10-15: the organization's private repositories may use
   Jig's actions**, and Dependabot may read Jig for its pin updates; a person
   changes both settings when build step 5 ships the action. Publishing Jig
   for other organizations stays a separate decision
   ([§ How CI runs it](#how-ci-runs-it)).

## Build order

Each step is one pull request with its change note and, where it changes
`plugin/`, a release. Jig keeps using the mechanism after every step.

1. **Move.** `reference/change-notes/` to `plugin/skills/changelog/scripts/`
   with its tests, behaviour unchanged; `lib/guarded-git-spawn.ts` to
   `plugin/shared/`, and the scripts' boundary onto `runMain()`; Jig's scripts and M12's
   links point at the new place. No `SKILL.md` yet, so no session pays for a
   skill that cannot run.
2. **Configuration and formats.** The `changelog:` section from the
   repository layer, in `config-schema.yaml` and CONFIGURATION.md, and the
   branch check reading it from its base; the note
   checker's structural check; versions from files of every kind above and
   from tags; Common Changelog; the first-release link;
   `status.ts`; Jig's own values move into its `.config/jig.yaml`. The skill
   gets its `SKILL.md`, `README.md`, a row in the plugin's skills table and
   its name in both manifests.
3. **One release per run**: `release.ts` writes everything
   waiting as one version (the reference's batch mode); Jig's
   `scripts/release.ts` stops setting `perMerge`, and the per-merge mode is
   kept or deleted as the ruling says; ADR-0002 and ADR-0004 amended.
4. **Converting, and the agents.** `convert.ts`; `do-item`, `drive-pr`,
   `resolve-review-comments` and `resolve-conflicts` taking part;
   `/followup` reading `status.ts`.
5. **CI and setup.** `action.yml`, the workflow template with both modes and
   the `tag` job, the release-pull-request rule of the branch check,
   `release-access.ts` (and Jig's branch-protection check reading rulesets
   through it), `/jig:changelog setup`. Jig's own workflow moves onto the
   action, the `tag` job and the two release jobs. `after_version` comes in
   this step and no earlier, in the same pull request as that split, so no
   repository command ever runs in a job that can read the key.
6. **The module.** M16 for releases and versions, with its invariant,
   levels, criteria (expected-absent for a repository that publishes no
   versioned artifact), the release-tag rule and mappings,
   in the module map, the profiles, the audit's methodology and the website;
   M10's library note pointing at it; M12 trimmed to its part; the
   audit's criteria naming the skill. Roadmap item 4's whole-file format
   check is built here or stays on the roadmap as its own item, and this
   design leaves `design/`.

## Left out

- **Several packages at different versions from one repository.** Changesets
  does this for JavaScript, and M12's mappings point there. The skill
  releases one version per repository.
- **Pre-release and calendar versions.** Versions are `major.minor.patch`;
  a repository that needs others keeps its own release step.
- **Writing entries from commit messages.** A note is written for the reader
  of the changelog; a commit subject is written for a reviewer.
  Release-please and semantic-release do that, and M12's mappings compare
  them.
- **Publishing the release elsewhere** (a GitHub Release, a package
  registry, an announcement). The skill stops at the commit and the tag;
  publishing is the repository's own pipeline, started by the tag. A GitHub
  Release built from the new section is a small later addition if
  repositories ask.
- **CI providers other than GitHub.** `check.ts`, `release.ts` and
  `convert.ts` run on any provider; another provider's template, and its
  adapters for `status.ts`, `release-access.ts` and setup, wait for a
  repository that needs them.

## Review

2026-10-15: critiqued at commit `921d539` and again at `59b7fef` by a
reviewer with fresh context (an agent session that did not write the
design), against the change-notes reference, Jig's release workflow, ADR-0002
to ADR-0004, M10, M12 and the plugin's rules.
