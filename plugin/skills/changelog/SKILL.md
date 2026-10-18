---
name: changelog
description: "Keep a repository's changelog from change notes: write the note for a change, check a branch against the repository's changelog configuration, convert a branch that edited the changelog itself, see which release the waiting notes make and which tags are owed; set a repository up for it, CI included (setup). Applies only where .config/jig.yaml sets changelog.file, except setup."
argument-hint: "[note | check | status | convert | setup]"
allowed-tools: "Read Write Edit Grep Glob Bash(bun *) Bash(git *)"
---

# Changelog: one change note per pull request

Many pull requests open at once cannot all edit the changelog and the version:
each merge would put every other pull request in conflict. So a pull request
adds a [change note](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
a small file of its own, and a release step on the integration branch writes
the notes into the changelog, moves the version and deletes the notes after
the merge. This skill is the agent's side of that: when a change needs a note,
how to write one a reader of the changelog can use, the commands that check
a branch and show what the next release will be, and the guided setup that
turns it on in a repository, CI included. The practices are Jig's
[M12](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md)
(no two pull requests edit the same lines) and
[M16](https://github.com/jig-harness/jig/blob/main/modules/M16-releases-versions/README.md)
(releases and versions); the human's page is [README.md](README.md).

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
entry, unless a person asked for `/jig:changelog setup`
([§ Setup](#setup)), which is how the skill gets turned on. A person's own `~/.jig/jig.yaml` or a `JIG__CHANGELOG__*` variable never
turns it on: the commands refuse those, naming where they were set. Where it is
on, `status.ts` also prints the notes waiting, the version they would make and
the notes that wait for a release, and each command prints the plugin version it
ran as.

## Writing a note

Write the note when you open the pull request, while the change is fresh, and
keep it true as review changes the change. Never add to the changelog's
Unreleased or release sections or edit any version file by hand: the release
step writes them, and the branch check fails a branch that does. Correcting
an entry already there (a link your change broke, a wrong word) or removing
one is allowed. Under Unreleased a correction rewrites a line where it stands,
under the same heading and with the same indentation and list or quote marker,
and adds none, so keep a longer correction on its line rather than rewrapping
it; the check names the lines it changes, removes or adds for the reviewer. In
a released section the reviewer reads the diff.

1. **Decide whether the change needs a note.** The changelog is written for
   the people who use what the repository releases, not for the people who
   work on it. A change needs a note when the repository's `release_paths` or
   `note_paths` cover a file it changes (the branch check says so), and
   whenever someone who uses the released artifact would want to know: a new
   capability, a changed behaviour or default, a fix to something a user hit,
   a deprecation, a removal, a security fix. Skip it for a change that only
   the people working on the repository notice (a refactor, a test, a CI or
   build tweak, the repository's own scripts and agent instructions, internal
   design documents, a project website) unless the check asks; when the check
   asks for a change no user sees, write one `patch` item that says so
   plainly. Where the repository writes down its own rule for what gets an
   entry (in its contributing guide or its notes folder's `README.md`), that
   rule decides. A repository with neither path configured never requires a
   note.

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

## Setup

`/jig:changelog setup` turns the skill on in a repository on GitHub, CI
included. Walk the person through the steps below in order, and check
each before starting the next: a step whose check fails is fixed before you
go on. **Change no repository or organization setting yourself**, not even
with a command that could: print what to change, with the exact values (or the
`gh` command the person can run), let the person change it, then run the
check. Writing files in the working tree (steps 1 and 4) is yours; commit them
on a branch and open a pull request like any change.

Before step 1 read where the repository stands: `gh repo view --json
nameWithOwner,visibility,defaultBranchRef`, and the integration branch
(`repository.base_branch`, else the default branch). The integration branch
should be the default branch: GitHub runs the workflow's tag jobs from the
default branch. Stop and explain when the repository is private and its plan
offers no rulesets or environments for private repositories (GitHub Free):
the release's key could not be kept to the integration branch.

1. **The configuration and the changelog.** Derive the values and show them
   for the person to confirm before you write: `file` (an existing
   `CHANGELOG.md`, else that name), `format` (detected from the file; ask when
   there is no file), the version (from `package.json`, `pyproject.toml` or
   `Cargo.toml`, else ask: files with keys, or `{ tags: true }`),
   `release_paths` (what ships in a release, such as `src/`), `note_paths`,
   and `release.push`: `direct` (the App pushes the release commit onto the
   integration branch, past its rules) or `pull-request` (the App opens a
   release pull request a person merges, and passes no rule). Write the
   `changelog:` section of `.config/jig.yaml` with only what differs from the
   defaults ([configuration](#configuration)). When the changelog is missing,
   create it from the format's template:
   `${CLAUDE_SKILL_DIR}/templates/keep-a-changelog.md` or
   `${CLAUDE_SKILL_DIR}/templates/common-changelog.md`. Check: `status.ts`
   prints the format and the released version, not `not configured` or an
   error.

2. **The App and its environment.** Both modes push as a GitHub App, since a
   push with the workflow's own token starts no other workflow. Fill in the
   App manifest for the mode, `${CLAUDE_SKILL_DIR}/templates/github/app-manifest-direct.json`
   or `app-manifest-pull-request.json` (`<owner>`, `<repository>`, and
   `<app-name>`, unique on GitHub, such as `<repository>-release`): Contents
   write, and Pull requests write in `pull-request` mode only; no Workflows
   permission, so no release commit can change a workflow; no webhook. Write,
   outside the repository, an HTML page with a form that posts it, and have
   the person open it and create the App:

   ```html
   <form method="post" action="https://github.com/organizations/<owner>/settings/apps/new">
     <input type="hidden" name="manifest" value='<the filled-in manifest>'>
     <button>Create the App on GitHub</button>
   </form>
   ```

   (For a repository a person owns, the action is
   `https://github.com/settings/apps/new`.) GitHub then sends them to the
   repository's page with a `code` in the address, which completes the
   App's registration when exchanged within one hour. The person exchanges
   it, printing only what identifies the App, never the key and secrets the
   answer also carries:
   `gh api -X POST app-manifests/<code>/conversions --jq '{id, slug, client_id}'`.
   The person then, by hand:
   - installs the App on **this repository only** (the App's page → Install
     App → Only select repositories);
   - generates a private key (the App's settings → Private keys);
   - creates the environment `changelog-release`, with deployment branches
     limited to the integration branch alone (Settings → Environments);
   - stores the App's client ID there as the variable
     `CHANGELOG_APP_CLIENT_ID` and the private key as the secret
     `CHANGELOG_APP_PRIVATE_KEY`
     (`gh variable set CHANGELOG_APP_CLIENT_ID --env changelog-release --body <client-id>`,
     `gh secret set CHANGELOG_APP_PRIVATE_KEY --env changelog-release < <key>.pem`),
     then deletes the downloaded key file.

   Check: `gh api repos/<owner>/<repository>/environments/changelog-release/deployment-branch-policies`
   lists the integration branch and nothing else;
   `gh variable list --env changelog-release` and `gh secret list --env changelog-release`
   name the two values; `gh api apps/<app-slug> --jq .permissions` shows
   `contents: write` (with `pull_requests: write` in `pull-request` mode) and
   no `workflows`. Ask the person to confirm the installation covers this
   repository only: the person's login cannot read it.

3. **The branch rules.** Read them first with
   `bun "${CLAUDE_SKILL_DIR}/scripts/release-access.ts" --app <app-slug> --json`:
   its `rulesets` are every ruleset that covers the integration branch, with
   its rules and bypass list, and `organizationRulesets` those an organization
   set. **Stop** with an explanation when a requirement fails because of an
   organization ruleset (its reason names an `organization ruleset` and says
   only an organization owner can change it): a repository ruleset's bypass
   cannot pass an organization's rule, so only an organization owner can let
   the App past it. An organization ruleset no requirement fails on, one
   that only blocks force pushes and deletion for one, needs nothing.
   - **`direct` mode.** Plan two repository rulesets on the integration
     branch and print them. The first carries the branch's current rules
     (from its rulesets and its classic branch protection), except blocking
     force pushes and deletion, and adds the App as a bypass actor
     (`Integration`, the App's id, mode `always`, not only for pull
     requests), keeping every bypass actor the branch already had
     (administrators, for one). The second blocks force pushes and deletion
     only, with no bypass actor that was not already allowed past them: a
     bypass actor passes every rule of the ruleset that names it, so those
     rules must sit where the App is not named. The person creates both
     rulesets first, then removes the classic protection: the branch is
     never unprotected, and until the classic protection is gone the App
     cannot pass it.
   - **`pull-request` mode.** No bypass on the integration branch. The App
     must be able to create, push and force-push `changelog.release.branch`:
     a ruleset that covers that branch with a creation, update or force-push
     rule must leave it out or let the App past.

   In both modes, a ruleset on tags (`gh api "repos/<owner>/<repository>/rulesets?targets=tag&includes_parents=true"`)
   that restricts creating tags matching `<tag_prefix>*` must let the App
   past, or no tag can be made. Check: `release-access.ts --app <app-slug>`
   exits 0. Exit 1 prints each requirement that fails, with its reasons: fix
   and run it again. Exit 3 means GitHub withheld something from the login
   that read it: a repository administrator runs the command and reads the
   `UNKNOWN` lines; it is not a reason to change a setting. In
   `pull-request` mode, until the release branch exists, the check exits 3
   with `release-branch` unknown because the branch `does not exist yet`:
   when that is the only `UNKNOWN` line, the person confirms that no classic
   branch protection rule (Settings → Branches) has a name pattern matching
   the release branch, and you go on; the check is run again once the first
   release run has made the branch (below).

4. **The workflow.** Copy `${CLAUDE_SKILL_DIR}/templates/github/changelog.yml`
   to `.github/workflows/changelog.yml` and replace every placeholder its
   header lists:
   - `<jig-owner>`: the owner of the Jig repository the plugin comes from;
   - `0000000000000000000000000000000000000000 # v0.0.0`: the full commit
     hash of the tag of the plugin version the commands print, with that
     version as the comment
     (`gh api repos/<jig-owner>/jig/commits/v<version> --jq .sha`), on every
     `uses:` of the action;
   - `<integration-branch>`: the integration branch, everywhere it appears;
   - `<workflow that reports a required check>`: the `name:` of each workflow
     whose jobs report a check the integration branch requires, one list
     entry each.

   The person makes the `check` job a required check of the integration
   branch (a required status check `check`, from GitHub Actions, in the
   first ruleset). On a push the job is skipped, which counts as passed when
   the workflow run it was skipped in succeeded (the release run), so it does
   not hold up a tag. A required check whose workflow runs only on
   pull requests never reports on the integration branch, so a version would
   wait for its tag forever: then set `ci.required_checks` in
   `.config/jig.yaml` to the checks that do run on the integration branch
   (`drive-pr` reads the same field, see the
   [configuration reference](../../CONFIGURATION.md#ci)). While Jig's
   repository is private, its owner must allow its actions to be used from
   the repository's organization (Jig's Settings → Actions → Access). Check:
   on the setup pull request, the `check` job runs and passes.

5. **The pull requests already open.** List them (`gh pr list --base
   <integration-branch> --state open`). For each, in a worktree of its
   branch, run `check.ts`; where it says the branch edited the changelog or
   the version, run `convert.ts --dry-run` and give the result to the pull
   request's owner. Convert a branch ([§ Converting a branch](#converting-a-branch))
   only when its owner asks, and leave the result uncommitted for them to
   review. Check: `check.ts` passes on each converted branch.

Before the setup pull request merges, run `status.ts` and show the person the
versions it lists as waiting for their tag: the first tag run tags those.
Only versions newer than the newest `<tag_prefix>x.y.z` tag on `origin` are
owed one, and with no such tag only the newest release heading, so an
untagged history stays untagged; the person confirms the list, or tags the
newest released version by hand first so that nothing older is owed. Once the
setup pull request merges, the first push runs the release; read `status.ts`
afterwards: its release run and its tags say whether the App could push and
tag. In `pull-request` mode, run `release-access.ts --app <app-slug>` again
once that run has made the release branch: it now reads the branch's classic
protection, and exits 0.

## The commands

Each is a script in `${CLAUDE_SKILL_DIR}/scripts/`, run from the repository
root, and prints the plugin version it ran as.

| Command | What it does |
|---------|--------------|
| `check.ts [--base <ref>] [--head-ref <name>]` | The branch check. Every note reads as the release step will read it; the branch leaves the version and the changelog's open and release sections to the release step; a branch touching a release path carries a note that asks for a release, and one touching a note path carries a note; in Common Changelog also the format's rules (breaking entries, one-line entries, entries that read the same with their reference appended, one notice, authors). The base is `--base`, else the base of the pull request in a CI job, else the hosting service's default branch. A **release pull request** (where the base's section sets `release.push: pull-request`, its head branch is the base's `release.branch`) passes instead when the release step, re-run on its merge base with the date of its one new release heading and without `after_version`, writes exactly its change; a file the release step does not own may differ only when the base sets `after_version`, and then only line for line by the old version becoming the new one (a whole version, not part of a longer one or of a name), and a file that is not valid UTF-8 text not at all; any other line, an added one naming the version included, is a finding. The head branch is `--head-ref`, else the pull request's in a CI job, else the checked-out branch. It needs the full history. Exit 0 clean or `not configured`, 1 findings (a base that cannot be found included), 2 a usage error. |
| `status.ts [--json]` | The notes waiting, the version they would make, the notes that wait for a release, and on GitHub whether the last release run on the integration branch succeeded, a release run still going answering first (read through `gh`; without `gh`, or on another host, it says it could not read it). It also lists each released version still waiting for its tag, with its state (`tag.ts`'s plan); without `gh` or `origin` that part says `unknown`. Exit 1 when a note is unreadable, the version files disagree, the last release run failed (a push or manual run of the workflow named `release` or `changelog`; its tag and branch-check runs are not release runs) or a releasing commit failed its required checks. |
| `convert.ts [--base <ref>] [--dry-run] [--json]` | Turns a branch that edited the changelog or the version itself into one with a note ([§ Converting a branch](#converting-a-branch)). Exit 0 converted, nothing to convert or `not configured`; 1 a refusal; 2 a usage error. |
| `tag.ts [--json] [--rerun]` | The tag plan: each version owed a tag (a release heading, no tag on `origin`, and newer than the newest `<tag_prefix>x.y.z` tag there; with no such tag, only the newest heading), its **releasing commit** (the first commit on the integration branch's first-parent line whose changelog has its heading) and its state: `ready` (every required check on that commit passed, and no older owed version is `pending` or `rerun`: versions are tagged oldest first), `pending` (a check has not finished, or the version waits for an older one), `rerun` (a check was cancelled and its workflow run not yet run again), `failed` (left for a person, a re-run GitHub refused included; it holds no newer version back, and once a newer one is tagged it is no longer owed a tag nor listed) or `imported` (its heading came in one commit with others, so it is tagged by hand if at all). The required checks are `ci.required_checks` in the integration branch's own `.config/jig.yaml`, else the branch's rules. A neutral or skipped check run passes only when its workflow run succeeded (skipped in a cancelled run is cancelled), or when no workflow run reported it. It never makes a tag; `--rerun` re-runs the `rerun` entries' workflow runs once. Exit 0 a plan (nothing owed and `not configured` included), 1 a version failed, a refused re-run included (the plan, `ready` list included, is still printed), 2 a usage error, a shallow clone, no required checks known, or git or GitHub could not answer. |
| `release-access.ts (--app <slug> \| --app-id <id>) [--repo <owner/repo>] [--json]` | Whether the release App can reach the integration branch in the configured mode, and force pushes and deletion stay blocked for it ([§ Setup](#setup)). Reads rulesets (every page) and classic protection; changes nothing. Exit 0 every requirement holds (or `not configured`), 1 one fails, 3 none fails but one is unknown (GitHub withheld a bypass list: a repository administrator must run it), 2 a usage error or GitHub could not be read. |
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
Outside the section, `tag.ts` and `status.ts` read `ci.required_checks`, the
checks a releasing commit must pass before its tag, from the integration
branch's `.config/jig.yaml` only (no person's file, no environment variable) (else the branch's rules
decide; with neither, tagging stops: no required checks known).

A **placeholder** is a text a file must hold before the release knows its
version (`since: next`): the release step replaces `from` with `to`, with
`{version}` filled in, in the files its `files` globs match, and never in a
workflow under `.github/workflows/`.

`after_version` is a command of the repository's, run after the version
changes and before the notes are deleted, for files that repeat the version (a
lock file). Its changes join the release. It does not run in a CI job (any of
`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TF_BUILD` or
`JENKINS_URL` set to something but `false` or `0`) unless the job sets
`JIG_AFTER_VERSION_IN_CI=1`. The skill's action sets it on its release step
only, in the workflow template's `release` job, which holds no key; the job
that pushes runs nothing from the repository. Its
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

It writes no entries from commit messages and publishes nothing, and its
commands do not commit, tag or push: in CI the action commits the release, and
the workflow template's key-holding jobs push it and make the tags. Setup
changes no repository or organization setting itself. Never suppress the
check: fix the note.
