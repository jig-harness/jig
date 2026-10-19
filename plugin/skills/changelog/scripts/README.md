# The changelog scripts

The commands behind [`/jig:changelog`](../README.md): the branch check, the
release step, the conversion of a branch, the status report, the tag plan and
the release-access check. They read the repository's `changelog:`
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
"waiting", "stamped", "changelog", "release" }`; `version` is null when no
note asked for a release, `notes` are the notes written and `waiting` the notes
left for a release, `changelog` is the changelog's path and `release` is
`{ "push", "branch" }` from `changelog.release`.

## The branch check

```sh
bun check.ts [--root <dir>] [--base origin/main] [--head-ref <branch>]
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
earlier release's text stays allowed, and so does correcting or removing an
entry already under Unreleased: each is rare and touches lines no other branch
does. Adding a section or an entry to Unreleased is refused, and so is deleting
the changelog. A note of an earlier branch that this one changes or deletes, and
a correction under Unreleased, are printed as a `note:` for the reviewer.

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

**A release pull request.** Where the base's section sets `release.push:
pull-request` and the branch is the base's `release.branch`, the branch is the
release step's own output, so the rules above would refuse it. It passes
instead when it is exactly what the release step writes on its merge base:

1. the changelog gains exactly one release heading, whose date is a real day
   no later than today (UTC);
2. the release step runs on the merge base in a temporary worktree (hooks off),
   dated from that heading and without `after_version`, with the plugin
   version running the check (in CI, the action's pinned one), and must make
   the heading's version;
3. every file the release step writes is byte for byte the branch's, and the
   branch adds or deletes nothing else. A file the release step does not
   write fails, unless the base sets `after_version`: then it may differ only
   by the version, line for line in order. It must have as many lines as the
   reproduction, and each line must be the reproduction's or that line with
   the old version replaced by the new one, as a whole version (not inside a
   longer version or a name: `1.2.0` in `"1.2.0"` or `p@1.2.0`, never in
   `11.2.0`, `1.2.0-rc.1` or `v1.2.0`). An added line, or one changed beyond
   the version, fails even when it names the version (the finding shows up to
   three of the lines that differ). Any file may differ this way; the rule
   does not name which files `after_version` may touch, but a file that is
   not valid UTF-8 text may not differ at all.

Its findings start with `release pull request: `; a pass prints
`change notes: OK — the release pull request is what the release step writes
on its merge base: <version>, dated <date>`. The branch is `--head-ref`, else
the head of the pull request that started the CI job (from the event, then
`GITHUB_HEAD_REF`), else the checked-out branch. The branch is judged against
the merge base it was written on, so a move of the base does not fail the
check; every push to the integration branch regenerates the release branch on
the new tip, and the check runs again on it.

## Converting a branch

```sh
bun convert.ts [--base origin/main] [--dry-run] [--json]
```

For a branch that edited the changelog or the version itself, as every branch
did before the repository adopted change notes. Against the merge base with the
base (a branch stacked on another converts against that branch, so only its own
edits count), it:

1. refuses while a merge, rebase, cherry-pick or revert has stopped, on
   uncommitted changes and on a detached `HEAD`, and on what the note cannot
   carry and would be lost: entries outside a `###` section, anything under one
   other than `- ` entries, a released version's section removed or renamed.
   A changelog or version file newer than the branch's fork point that the
   branch lacks too is left out (a missing changelog reads as empty); one the
   branch created on its own as well is refused, since its edits cannot be told
   from the base's;
2. writes the release sections the branch added and its additions to Unreleased
   as one note, named after the branch like any note, in the order and with the
   headings of the format. A Common Changelog entry loses the reference and the
   authors the release step appends, and the authors go into the note's front
   matter; each relative link is rewritten from the changelog's folder to the
   notes folder. A note the branch already has takes the entries it does not
   hold yet, and where only one side names authors the other side's history
   is named too;
3. gives the note the `release` of the bump from the merge base's version to the
   branch's (none when the branch did not move it);
4. puts back the merge base's Unreleased section, the release sections the
   branch added and its version, and keeps the branch's edits to earlier
   releases and to the comparison links they use. An Unreleased entry the
   branch moved into a release under another change type, edited or removed
   is printed as `attention:`, since the base's text comes back;
5. sets a placeholder the branch filled with its own version back to its `from`,
   and only that: a value goes back only where the file holds more of it than
   the merge base did, so an earlier merge's stamp is left alone even on a line
   the branch edited. Where an added line is the same as one the merge base
   already has, the two cannot be told apart by their text, so the value stays
   and the line is printed as `check:`, as is any other added line that names
   the version, for a person to look at;
6. leaves all of it uncommitted, and prints what it did.

`--dry-run` writes nothing. The note it writes may still have a problem the
check would find (a heading the format does not list, say); each is printed as
`attention:`. Exit 0 converted, nothing to convert or `not configured`; 1 a
refusal; 2 a usage error, an invalid configuration or an unreadable file.

## The status report

```sh
bun status.ts [--json]
```

The current version, the notes that ask for a release and the version they would
make, the notes that wait for a release (or that the next run writes under
Unreleased), and, when `origin` is on GitHub and `gh` answers, whether the last
release run on the integration branch (`repository.base_branch`, else the
default branch) succeeded. The run is the newest release run, one started by a
push or by hand (its tag and branch-check runs are not), of the workflow named
`release` or `changelog` (the name of the workflow setup copies in), in any
letter case (a workflow that only mentions the word, such as a release-notes
drafter, is not it), that is still going, else its newest one: a
release run still going is never cancelled by a later one, so an older run still
going answers before a newer one that ended, and the report is then `running`
(exit 0) rather than the newer run's result. Only that workflow's runs are read,
so other workflows' runs cannot hide one. Its runs are listed back to the
horizon past which none can still be going (GitHub ends a run 35 days after it
starts and re-runs one at most 30 days after it was created; a day more covers
a clock that is off), in listings split by when a run was created rather than
by its status, so newer runs that ended cannot hide one and a run whose status
changes between two listings is still seen. With no run since that horizon,
the newest run answers. A host without an adapter, a missing or signed-out
`gh`, an unreadable answer, or a listing `gh` filled to the limit it was asked
for and that cannot be reached past (a workflow list, more runs created in one
second than a listing holds, or more listings than the read takes) is reported
as "unknown", never as a failure.
It ends with the released versions still waiting for their tag, from the
tag plan below: each with its state, and a failed releasing commit with the
checks that failed (`released, waiting for its tag:` then `  v1.3.0: failed
(failed: test); releasing commit <sha>, failing: test`), or `tags: no
released version waits for its tag`, or `tags: unknown (…)` where `origin` or `gh`
cannot answer. `--json` adds `tags`: `{ "known": true, "untagged": [{ "version",
"tag", "state", "detail", "commit", "failing" }] }` or `{ "known": false,
"detail" }`.
Exit 1 when a note is unreadable, the version files disagree, the last release
run failed or a releasing commit failed its required checks; 2 for a usage
error, an invalid configuration or an unreadable file.

## The tag plan

```sh
bun tag.ts [--root <dir>] [--json] [--rerun]
```

A version is tagged on the commit that released it and on no other: its
**releasing commit**, the first commit on the integration branch's
first-parent line (its own history, without the commits of the branches merged
into it) whose changelog has the version's heading. However the release reached
the branch (a squash, a merge commit, a rebase, a direct push), that commit
holds exactly the release. A version is owed a tag when it has a heading, no
`<tag_prefix><version>` tag on `origin` (any tag of that name counts), and is
newer than the newest `<tag_prefix>x.y.z` tag on `origin`; with no such tag
on `origin`, only the newest release heading is owed one. So a repository
that adopts the workflow with an untagged history never has its old versions
tagged and published: `status.ts` shows what the first run would tag, and
tagging the newest released version by hand first leaves nothing older owed.
Versions are tagged oldest first, since a newer tag on `origin` leaves an
older version no longer owed one: a version whose checks passed waits while
an older owed version is `pending` or `rerun`. An older `failed` version
holds nothing back; it is left for a person, its failed `tag.ts` run is the
report, and once a newer version is tagged it is no longer owed a tag, so
neither `tag.ts` nor `status.ts` lists it again.
Each version owed gets one state:

| State | Meaning |
|-------|---------|
| `ready` | every required check on the releasing commit itself passed, and no older owed version is `pending` or `rerun`: the tag can be made |
| `pending` | a required check is queued, running or has not reported yet; or every check passed and the version waits for an older one, whose tag `waitsFor` names |
| `rerun` | a required check was cancelled, none failed, and its workflow run's attempt number is still 1 |
| `failed` | a required check failed, or was cancelled again after a re-run, or was cancelled outside a workflow run, or `--rerun` asked GitHub to run it again and was refused (GitHub refuses a run older than 30 days): left untagged for a person |
| `imported` | its heading came in one commit with other release headings (a changelog brought in with its history), so no commit released it: tagged by hand if it is owed a tag at all |

The required checks are `ci.required_checks` when the integration branch's
`.config/jig.yaml` sets it (`[]` tags without any; a person's file and the
environment are not read), else the checks the branch's rules require, classic
protection and rulesets together; with neither, the plan stops: no required
checks known. A check pinned to an app is met only by that app's check runs;
an unpinned one takes the worst of its check runs and commit statuses.
The newest check run per name and app that did its work answers. A
`neutral` or `skipped` check run did none: with only those, it counts as
passed when one's workflow run succeeded or no workflow run reported it (a
check from another app), as pending while its run goes on, as cancelled when
its run was cancelled (a job with `if: ${{ !cancelled() }}` is skipped in a
cancelled run), and as failed otherwise. A later commit's success never stands in for the releasing commit's.
The changelog, the `changelog:` section, `ci.required_checks` and the history
are read from the integration branch, the tags from `origin` (`git ls-remote --tags`), never from
the working tree or this clone's tags; a shallow clone is refused.

It makes no tag. `--rerun` re-runs, once, the workflow runs of the `rerun`
entries (it needs a token with Actions write); without it the script only
reads. A re-run GitHub refuses fails the versions that needed it, with the
reason in their `detail`; the plan, `ready` included, still holds for the
others. `--json` prints `{ "plugin", "configured", "branch", "ref",
"tagPrefix", "newestTag" (the newest `<tagPrefix>x.y.z` tag on `origin`, or
null), "requiredChecks": { "source": "configuration" | "branch rules",
"names" } | null, "versions": [{ "version", "tag", "commit", "state",
"detail", "checks": [{ "name", "verdict", "detail", "url"?, "run"? }],
"rerun": [], "waitsFor"? }], "ready": [{ "tag", "commit", "message" }], "reruns": [{ "run",
"requested", "detail"? }] }`, versions oldest first. The `ready` list is what
the workflow template's `tag-push` job tags, as an annotated tag made through
GitHub's API. Exit 0 a plan was made (nothing owed and `not configured`
included); 1 a version failed (its releasing commit failed its required
checks, or a re-run it needed was refused), with the whole plan, `ready`
included, still printed; 2 a usage error, an invalid configuration, a
shallow clone, no required checks known, or something git or GitHub could not
answer.

## The release-access check

```sh
bun release-access.ts (--app <slug> | --app-id <id>) [--root <dir>] [--repo <owner/repo>] [--input <file>|-] [--json]
```

Whether the release's GitHub App can reach the integration branch in the
configured mode, read from GitHub's rulesets (every page of the branch's rules)
and classic branch protection combined, the most restrictive setting winning.
It changes nothing. The App is `--app-id`, else the id `gh api apps/<slug>`
gives; only a bypass entry of type `Integration` with that id names it, never
a role, a team, an organization administrator or a deploy key. The repository
is `--repo`, else `origin`'s.

| Requirement | Mode | Holds when |
|-------------|------|-----------|
| `push` | `direct` | every active ruleset with a rule that would stop the release's push lists the App with bypass mode `always` (or `exempt`), and no classic protection stops it (required checks or reviews, push restrictions without the App, signed commits, a locked branch) |
| `release-branch` | `pull-request` | the App can create, push and force-push `changelog.release.branch`; its rules are read even before it exists, its classic protection is unknown until it does |
| `force-push-blocked`, `deletion-blocked` | both | classic protection, or a `non_fast_forward` or `deletion` rule in an active ruleset that does not list the App, blocks it for the App too |

A rule that cannot stop the release's one fast-forward commit (`non_fast_forward`,
`deletion`, `creation`, `required_linear_history`, `copilot_code_review`)
needs no bypass; every other rule, an unknown one included, does. On the
release branch `creation` and `non_fast_forward` count as well. Where GitHub
withheld a bypass list, or classic protection could not be read, the
requirement is `UNKNOWN`, never passed or failed: a login without
administrator rights gets unknowns, not an error. An organization ruleset is
judged like the others and listed apart, since no repository setting changes
it; setup stops where a requirement fails because of one.

The text output prints `PASS`, `UNKNOWN` or `FAIL` and a summary per
requirement, with its reasons indented, and ends `N of M requirements hold`.
`--json` prints `{ "plugin", "configured", "mode", "repo", "identity": { "id",
"slug" }, "integrationBranch", "releaseBranch", "status": "pass" | "fail" |
"unknown", "requirements": [{ "id", "status", "summary", "reasons" }],
"rulesets": [{ "branch", "id", "name", "enforcement", "source", "rules",
"bypass" }], "organizationRulesets": [{ "id", "name" }] }`, `bypass` null where
it was withheld. `--input` reads an offline document instead of GitHub (the
shape `scripts/check-branch-protection.ts --input` takes in Jig, with
`release_branch`, required in `pull-request` mode, and optional `app` and
`repo`). Exit 0 every requirement holds (or `not
configured`); 1 one fails; 3 none fails but one is unknown, for a repository
administrator to read; 2 a usage error, an invalid configuration, or GitHub
could not be read.

Jig runs these on itself: `.github/workflows/release.yml` uses the skill's
action from its own checkout for the release and the tags, `scripts/release.ts`
runs the release step locally, `scripts/check-changelog.ts` runs the check in
`bun run gates`, all reading Jig's own `changelog:` section, and
`scripts/check-branch-protection.ts` reads main's rulesets through
`github-rules.ts`. The self-tests are in [`../__tests__/`](https://github.com/jig-harness/jig/tree/main/plugin/skills/changelog/__tests__).
The practice is
[M12's change records](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md).
