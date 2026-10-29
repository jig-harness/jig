# Configuration reference: `.config/jig.yaml`

The Jig skills hold the procedure; each repository holds its own
values. Without one place listing those values, a repository adopts a skill
by trial and error: an agent improvises what the repository never stated (how
to name a branch, whether pull requests may stack), and a
misspelt field silently keeps its default. This document lists every field
the skills read, its type, what it does, what happens when it is absent, and
which skill reads it. It is the complete reference; the skill READMEs explain
the behaviour behind each field.

The file is the repository's [consumer overlay](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): its own
values, laid over the shared procedure. Values that belong to a person or a
machine rather than to one repository go in a user file instead, and a single
run can override either through environment variables: see
[configuration layers](#configuration-layers). Every field is optional unless
its row says otherwise. Add a field only when its default does not fit.

Contents: [the file](#the-file) ·
[configuration layers](#configuration-layers) ·
[what is derived, not declared](#what-is-derived-not-declared) ·
[`gates`](#gates) · [`review`](#review) · [`repository`](#repository) ·
[`pull_requests`](#pull_requests) · [`drive`](#drive) · [`ci`](#ci) ·
[`issue_tracker`](#issue_tracker) · [`do_item`](#do_item) ·
[`work_batch`](#work_batch) · [`routing`](#routing) ·
[`fleet_health`](#fleet_health) · [`verify`](#verify) ·
[`reflection`](#reflection) · [`changelog`](#changelog) ·
[`code_stats`](#code_stats) · [`gc`](#gc) ·
[procedure skills](#procedure-skills) ·
[environment variables](#environment-variables) ·
[complete example](#complete-example)

## The file

- **Location.** `.config/jig.yaml` at the root of the
  repository. The root is the nearest folder above the working directory that
  holds `.git`; `JIG_CONSUMER_ROOT` overrides it, and
  `JIG_OVERLAY` points the skills at a different file altogether.
- **Format.** YAML. JSON is valid YAML, so a JSON file works too.
- **Missing file.** `resolve-review-comments` and the tracker scripts of
  `do-item` refuse to run: an installed skill in a repository that has not
  adopted it says so rather than guessing. `drive-pr`, the pull-request
  policy and the procedure skills run on their defaults.
- **Unknown fields** are ignored at the top level and inside most sections, so
  other tooling can share the file. The maps whose keys the skills look up
  are strict instead: there a misspelt key would silently keep the default it
  was written to change, so it is an error. They are `pull_requests`,
  `issue_tracker.states` (keys are canonical states),
  `issue_tracker.labels` (keys are label roles), `resolve_conflicts`
  (including each `generated` entry), `reflection`, `verify` and `code_stats`
  (including each `areas` entry, and `kinds`, whose keys are kinds). In `review.taxonomy` every
  key other than `provenance_label` and `epic_label` is read as a list of
  distinct, nonempty strings, so an unrelated key there is an error too.
- **Wrong types** are refused with an error that names the field, except by
  a few best-effort `drive-pr` readers, which treat a wrong-typed value as
  absent and use the default instead: `review.bots` when it is not a list
  (entries that are not strings are dropped), `drive.escape_baseline_doc`,
  and the `fleet_health` fields. The checks below report refused values
  only, and only for the fields they print.
- **Check it.** `bun <plugin>/skills/resolve-review-comments/scripts/jig-config.ts`
  prints every field set in any layer, its value and the file or variable
  that set it (`jig-config.ts review` narrows it to one section, `--json`
  for a script);
  `bun <plugin>/skills/audit/scripts/config-fit.ts` checks the repository's
  file against the plugin's machine-readable
  [schema](skills/audit/config-schema.yaml) and against the repository:
  unknown, refused, deprecated and mistyped fields, commands and paths that do
  not exist, required checks that never run, and declared values the
  repository contradicts; with `--draft` it prints a starter file instead,
  each value the repository implies with the fact it came from;
  `bun <plugin>/skills/resolve-review-comments/scripts/consumer-config.ts`
  prints the review skill's values or what is missing;
  `bun <plugin>/skills/do-item/scripts/pr-plan.ts open` prints the pull-request
  policy as it applies to the current branch.
- **One list of fields.** The schema and this document list the same fields
  with the same readers, and the schema's value sets are the ones the reading
  skills accept; the audit skill's tests fail when they differ. A field added
  to a skill is added to both in the same pull request, with `since:` the
  plugin version that adds it, so an audit can report it as new. The pull
  request writes `since: next`, and Jig's release step replaces it with the
  version it releases.
- **The audit record.** `/jig:audit` keeps what it found in
  `.config/jig-audit.yaml` beside this file; it is not configuration, and no
  other skill reads it.

## Configuration layers

The skills read their values from up to three
[configuration layers](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md). A higher layer overrides a lower one:

| Layer | Where | Holds |
|-------|-------|-------|
| 1. User | `~/.jig/jig.yaml`; `JIG_HOME` moves the `~/.jig` folder | One person's or one machine's values, for every repository: a personal default, a folder shared by all repositories |
| 2. Repository | `.config/jig.yaml` ([the file](#the-file)); `JIG_OVERLAY` names a different file | The repository's own values |
| 3. Environment | `JIG__<SECTION>__<FIELD>` variables | One run's values |

Command-line flags, where a script has them, override all three.

- **Merging.** Sections merge field by field: a user file that sets
  `review.sticky_marker` and a repository file that sets `review.bots` give
  both. Any other value (text, a number, a date, a list, `null`) replaces the
  lower layer's value whole, so a list is never part one layer's and part
  another's.
- **Environment variables.** Two underscores separate the levels and the
  names are read in lower case: `JIG__ISSUE_TRACKER__TEAM=ENG` sets
  `issue_tracker.team`. `true`, `false`, `null`, decimal numbers (`400`,
  `+400`, `-0.5`, `.5`, `1e3`), and lists or maps written in YAML's bracket
  form (`[a, "b[bot]"]`) take their type; anything
  else is text as written. A value in quotes is the text inside them
  (`JIG__REPOSITORY__BASE_BRANCH="'1.10'"`), which keeps a value that looks
  like a number, `true` or a bracketed shell command as text; a field given
  the wrong type refuses it and names the variable. An empty variable is not
  set. Two variables for one field, or one that sets a value and another
  that sets a field inside it (`JIG__DRIVE` beside
  `JIG__DRIVE__REVIEWS_DRAFTS`, whatever `JIG__DRIVE` holds), are an error. The older per-field variables
  (`DRIVE_PR_BASE_BRANCH` and the others under
  [environment variables](#environment-variables)) still work and override
  all three layers.
- **Fields only a repository sets.** `gates.command`,
  `repository.base_branch`, `issue_tracker.team`, `review.repo_slug`,
  `review.repo_label`, `ci.required_checks`, every `changelog` field and
  every `code_stats` field describe one repository. Set in the user file
  they would apply to every repository on the machine, so the user file
  refuses them with an error naming the field. An environment variable may still override them for one run,
  except the `changelog` fields, which the `changelog` skill reads from the
  repository's own file alone and refuses from any other layer
  ([`changelog`](#changelog)).
- **Fields only a user file sets.** [`clones`](#clones-user-file-only)
  describes one machine, so a repository's file refuses it; an environment
  variable may still set it for one run.
- **Adoption is the repository's file.** A user file alone does not make a
  repository look adopted: `resolve-review-comments` and the tracker scripts
  still refuse to run without `.config/jig.yaml`. The skills that run on
  their defaults read the user file and the environment either way.
- **Paths** in any layer are relative to the repository root, as in the
  repository's file, except the clone paths of `clones`, which are absolute.
- **Errors** name the file or variable that set the field at fault, and
  `jig-config.ts` shows which layer set each field. It writes a key that
  holds a dot in quotes (`do_item.agents.title_keywords."node.js"`), and
  accepts a field written the same way.
- **Shape.** No layer may hold a `__proto__` key, a value that contains
  itself (a recursive YAML alias), or more than 10,000 values once its
  aliases are expanded; each is an error naming the file or variable. The
  environment layer is every `JIG__*` variable together, so the bound holds
  for them combined as well as for each one.
- **Leaving the user layer out.** `JIG_USER_LAYER=off` reads the repository
  file and the environment only. The independent review sets it, so its
  policy comes from the base branch's file alone.

## What is derived, not declared

Jig reads a fact from the repository when the repository already
states it, instead of asking for it twice. These have no field, or have a
field only to override the derivation:

| Fact | Where it is read | Used for | Override |
|------|------------------|----------|----------|
| Integration branch (the branch pull requests land on) | The clone's `origin/HEAD` (drive-pr and do-item: the `HEAD` of `repository.remote`), else GitHub's default branch | Pull-request base, round diffs, CI policy | `repository.base_branch`, `DRIVE_PR_BASE_BRANCH` |
| Pull-request template | `pull_request_template.md` (or `.txt`, any letter case) in the root, `.github/` or `docs/`, and the files of a `PULL_REQUEST_TEMPLATE/` folder there | The body an agent fills in | none: edit the template |
| Title convention | A commitlint configuration (`commitlint.config.*`, `.commitlintrc*`, `commitlint` in `package.json`) that names the Conventional Commits rules, such as `@commitlint/config-conventional`; else at least 80% of the last 30 non-merge trunk commit subjects following [Conventional Commits](https://www.conventionalcommits.org/), and at least five such subjects to judge from | Whether titles take `type(scope): summary` | `pull_requests.title_format` |
| Delete head branches on merge | GitHub repository settings | Warning for `branch` stacking: without it GitHub does not retarget the layer above a merged one | none: change the setting |
| Code owners | `.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS` | Reported only: GitHub requests those reviewers itself | none |
| Required checks | The protection and rulesets of the branch the pull request (or its stack) lands on | Which checks certify a converged head | `ci.required_checks` |
| Draft or Ready on opening | `drive.reviews_drafts: false` means Ready | How a pull request opens | `pull_requests.open_as` |
| Agent runtime | The variables the runtime sets (`CLAUDECODE` for Claude Code, `CODEX_…` for Codex) | Which row of `routing.models` and `routing.efforts` a route is translated through | none |

## `gates`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `gates.command` | shell command | **Required by `resolve-review-comments`**, which refuses without it. `drive-pr` then has no local checks unless `drive.validation_plan_command` is set | resolve-review-comments, drive-pr, fix-ci, resolve-conflicts, descar | The repository's complete local checks, run before every push |

## `review`

How review threads are resolved and how the drive recognises its AI reviewer.

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `review.bots` | list of logins | No reviewer named: threads are worked whoever wrote them | resolve-review-comments, drive-pr, review | Reviewer accounts (for example `example-review[bot]`) the review skills name as the repository's reviewers. The review skill works every unresolved thread whether or not it is set; `--bots-only` keys on GitHub App authorship, not on this list. Without `review.reviewer_app`, the drive accepts the reviewer's summary comment only from these logins |
| `review.job_pattern` | regular expression, or `null` | Reviewer checks recognised by name | resolve-review-comments | Which check runs the review skill waits on. Setting it requires `review.required_checks`. `--job-pattern` overrides it |
| `review.required_checks` | list of distinct check names | none | resolve-review-comments | Reviewer checks that must each complete before a round is judged. Required when `review.job_pattern` is set. Unrelated to `ci.required_checks` |
| `review.deferral_team` | team key | none: deferring a finding with no originating issue then needs `--team` | resolve-review-comments | Tracker team that deferred findings are filed into. `--team` overrides it |
| `review.repo_label` | label | Empty, which fails unless `--repo-label` is given | resolve-review-comments, work-batch | Repository label put on filed follow-ups, and the one a batch item must carry; must be one of `review.taxonomy.repos`. Only letters, digits and `. _ : @ + / -`: the label is part of a deferral batch's key, which the review skill refuses to write otherwise |
| `review.repo_slug` | `owner/name` | Empty, which fails unless `--repo-slug` is given | resolve-review-comments | Repository whose links a deferred finding must point into |
| `review.taxonomy.types` | list of labels | none | resolve-review-comments, work-batch | Type labels a follow-up may carry, one of which a batch item must carry. Requires `ownership_prefixes`. Only letters, digits and `. _ : @ + / -`: the label is part of a deferral batch's key, which the review skill refuses to write otherwise |
| `review.taxonomy.repos` | list of labels | none | resolve-review-comments, drive-pr (fleet health), work-batch | Repository labels a follow-up may carry. Requires `ownership_prefixes`. Only letters, digits and `. _ : @ + / -`: the label is part of a deferral batch's key, which the review skill refuses to write otherwise |
| `review.taxonomy.sizes` | list of labels | `[xs, small]` | resolve-review-comments, work-batch | Size labels a batch of follow-ups may carry |
| `review.taxonomy.categories` | list of names | only `unknown` | resolve-review-comments | Allowed finding categories |
| `review.taxonomy.context_prefixes` | list of prefixes | none | resolve-review-comments, work-batch | Prefixes of labels carried from the pull request onto its follow-ups. Requires `ownership_prefixes` |
| `review.taxonomy.ownership_prefixes` | list of prefixes | none | resolve-review-comments | Prefixes of ownership labels; two findings share a batch only when these agree. Required when `types`, `repos` or `context_prefixes` is set |
| `review.taxonomy.provenance_label` | label | `pr-followup` | resolve-review-comments, drive-pr (fleet health) | Older name for `issue_tracker.labels.followup`, still read when that is unset; the two may not disagree |
| `review.taxonomy.epic_label` | label | `epic` | resolve-review-comments, drive-pr (fleet health) | Older name for `issue_tracker.labels.epic`, still read when that is unset; the two may not disagree |
| `review.scanner_apps` | list of GitHub App slugs | `[sonarqubecloud]` | resolve-review-comments | Apps whose check-run annotations are findings to triage: a static-analysis app that decorates the pull request with annotations instead of review threads (SonarQube Cloud does). Listed by `list-scanner-annotations.ts`, which waits for each configured app to report on the head; the default app is read only where it runs |
| `review.reviewer_app` | GitHub App slug | none | drive-pr | App whose check runs and `<app>[bot]` summary comment are the AI reviewer's evidence. Setting it, or `review.reviewer_check_pattern`, is what makes the drive expect an AI reviewer; with neither, the drive waits for none and converges on threads and CI. `DRIVE_PR_REVIEWER_APP` overrides it |
| `review.reviewer_check_pattern` | anchored regular expression | `^ai[ _-]?review(\s*\(.+\))?$`, used once a reviewer is expected | drive-pr | Name of the posting reviewer's check run. Matched case-insensitively, so `^ai review$` also matches `AI Review`; POSIX classes such as `[[:space:]]` are accepted. Without `review.reviewer_app`, reviewer checks are recognised by name from any app and the summary comment is accepted only from `review.bots`. `DRIVE_PR_REVIEWER_CHECK` overrides it |
| `review.sticky_marker` | text | `<!-- ai-code-review -->` | drive-pr | Text identifying the reviewer's summary comment. Read only when a reviewer is expected. `DRIVE_PR_STICKY_MARKER` overrides it |
| `review.reviewed_sha_marker` | text | `ai-reviewed-sha` | drive-pr | Marker for the commit the reviewer reviewed, inside that comment. Read only when a reviewer is expected. `DRIVE_PR_SHA_MARKER` overrides it |
| `review.severity_formats` | list of `{login, shape, severities}` | none: the [built-in formats](EXTENDING.md#severity-formats) only | drive-pr, resolve-review-comments | How a reviewer writes a finding's severity, so the decline ladder can use it: a reviewer with no built-in format, or words or a shape a built-in format does not read. `login` is the reviewer's GitHub login (`[bot]` optional); `shape` is `bold-token` (`🟡 **Major**`), `badge` (a `![P1 Badge]` image), `html-badge` (an `<img alt="P1">` image), `pipe-fields` (`**category** \| **Major** \| **effort**`) or `icon-fields` (`**<picture>…</picture> Major** · **category** · **effort**`); `severities` maps each of the reviewer's words to `blocker`, `high`, `medium` or `low`. Read before the built-in formats, which still apply to a comment no entry reads, and only on comments that login posted. `null` means not set |

The [resolve-review-comments README](skills/resolve-review-comments/README.md)
and the [drive-pr README](skills/drive-pr/README.md) explain how these are used.

### The review-triage file

In late review rounds, `resolve-review-comments` can decline a finding it
would otherwise fix, because every pushed fix summons the reviewers for
another full round. This is the
[decline ladder](skills/resolve-review-comments/references/triage-rubric.md#the-decline-ladder).
Which rounds decline what is the repository's choice, in its own file:
`.config/review-triage.yaml` (`JIG_REVIEW_TRIAGE_CONFIG` names another
file). Without the file the ladder is off and every finding the rubric
accepts is fixed. A file that cannot be read, or that fails the checks below,
also leaves the ladder off, and each verdict reports why. An unknown key is
an error.

| Field | Type | Required | What it does |
|-------|------|----------|--------------|
| `version` | `1` | yes | Schema version |
| `severity_order` | exactly `[low, medium, high, blocker]` | yes | The reviewer severities, weakest first |
| `categories` | non-empty list of distinct names, not `unknown` | yes | The finding categories that `--category` and the bands' clauses use |
| `fail_open.inert_when_unknown` | list drawn from `severity`, `category`, `tier`, `self_inflicted`; may be empty | yes | Inputs whose `unknown` value turns the ladder off for that finding |
| `bands` | non-empty list of `{id, from_round, through_round, minimal_diff, accept_if}` | yes | Round ranges, contiguous from round 1; the last one has `through_round: null`. A finding is kept when it meets any clause of its band's `accept_if` (`unconditional`, `min_severity`, `categories`, `max_tier`, `self_inflicted`) and declined otherwise. `minimal_diff: true` limits the fix of a kept finding to the smallest change |
| `reply.marker`, `reply.wont_fix`, `reply.deferred` | text | yes | The reply posted on a declined thread. Each template ends with a `<!-- {marker} -->` line, which the loop-cost reports look for |
| `severity_mapping` | map from each severity, and `unknown`, to `{priority, acceptance}` | no | The tracker priority (0 none, 1 urgent to 4 low) and acceptance tier each severity corresponds to; checked when present, not used by the ladder. `linear_priority` is accepted as an alias of `priority` |
| `calibration` | any | no | Notes for people; not read |

The [test fixture](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
[`review-triage.yaml`](https://github.com/jig-harness/jig/blob/main/plugin/skills/resolve-review-comments/__tests__/fixtures/review-triage.yaml)
is a complete example.

## `repository`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `repository.base_branch` | branch name, without the remote's prefix (`origin/`) | Derived: the clone's `origin/HEAD` (drive-pr and do-item: the `HEAD` of `repository.remote`), else GitHub's default branch | drive-pr, do-item, review, descar, changelog | The integration branch: where pull requests land. A round diffs against its pull request's own base, so a stacked layer's round covers that layer alone; it diffs against this branch only on a branch with no pull request, and refuses when the pull request's base cannot be read or fetched, or the remote (`repository.remote`) is not the pull request's repository. The required checks come from the protection of the pull request's base and, for a stacked layer, of the branch the stack's bottom layer targets; a walk down the stack stops at this branch, and an unknown integration branch is an error. Set it when that is not the default branch (a `develop` flow). `DRIVE_PR_BASE_BRANCH` overrides it. changelog: the integration branch its release, tag plan, status and `release-access.ts` work on |
| `repository.remote` | git remote name: ASCII letters, digits, `.`, `_`, `-` and `/`; no leading `-`, and none of the sequences a ref name refuses (`..`, `//`, a leading or trailing `/`, a trailing `.`, a component starting with `.` or ending in `.lock`) | `origin` | drive-pr, do-item, fix-ci, resolve-conflicts, work-batch, file-issue, reflect | The git remote of the clone the skills push to and fetch from. drive-pr: it fetches the pull request's base from it, diffs against `<remote>/<base>`, derives the integration branch from `<remote>/HEAD`, pushes the round's commits to it, and refuses to fetch or push when the remote's addresses do not name the pull request's repository; the conflict fix it prints names it. do-item: `pr-plan.ts open` measures the change against `<remote>/<base>` and prints the remote (`remote:`) the branch is pushed to. fix-ci: the default of `probe-base.ts --remote`. resolve-conflicts: `<remote>/HEAD` names the default branch, and its merge commands fetch from it. do-item, work-batch, file-issue, reflect: with GitHub Issues and no `issue_tracker.github.repository`, the remote's address names the repository. Set it when the clone names that remote otherwise (`upstream`, or a fork setup where `origin` is the fork). A person may set it in the user file for every clone; an unusable name, `null` included, is an error naming where it was set, and so is a `repository` section that is `null` or not a mapping |

## `pull_requests`

How agents open and stack pull requests. `do-item` applies it through
`scripts/pr-plan.ts` when it opens a pull request; `drive-pr` applies
`mark_ready` as a drive runs. Merging is not configurable: a person merges.
Without the section the policy is: one pull request
per change against the integration branch, branch named `{key_lower}-{slug}`,
opened as a draft, marked Ready after the first review round, closing its
issue on merge, merged by a human.

| Field | Values | When absent | What it does |
|-------|--------|-------------|--------------|
| `pull_requests.stacking` | `none`, `native`, `branch` | `none` | Whether a pull request may be based on another open pull request's branch instead of the integration branch. See [stacking](#stacking) |
| `pull_requests.max_stack_depth` | whole number ≥ 1 | no cap | Most pull requests one stack may hold, the new one included. Needs `stacking` other than `none` |
| `pull_requests.open_as` | `draft`, `ready` | `ready` when `drive.reviews_drafts` is `false`, else `draft` | How a new pull request opens |
| `pull_requests.mark_ready` | whole number ≥ 1, `converged`, `never` | `1` | When `drive-pr` marks a draft Ready for review: after round N completes, only once the draft-reviewing reviewer has nothing left (`converged`), or never (a person marks it). A draft that converges before round N is marked at convergence, since reviewers that skip drafts would otherwise never see it. Marking Ready summons those reviewers, so a later number spends their review on a cleaner head |
| `pull_requests.branch_name` | pattern | `{key_lower}-{slug}` | Branch name for an issue. Placeholders: `{key}` (`ENG-12`), `{key_lower}` (`eng-12`), `{slug}` (the issue title in lowercase words joined by `-`, at most 40 characters). Must contain `{key}` or `{key_lower}`: the issue key in the branch name is what links the pull request to its issue. Placeholders must be separated by at least one character, the key must not have a digit beside it, and `{slug}` may appear once, or the key cannot be read back from a branch. Example: `feature/{key_lower}-{slug}` |
| `pull_requests.issue_link` | `closes`, `refs`, `none` | `closes` | The line linking the pull request to its issue: `Closes ENG-12` (merging closes the issue), `Refs ENG-12` (linked, left open), or none |
| `pull_requests.size_budget` | whole number ≥ 1 | no budget | Most changed lines (added plus deleted, against the pull request's base) one pull request may carry; the audit record `.config/jig-audit.yaml`, which every audit rewrites whole, is not counted, and `pr-plan.ts` names it beside the size. Over it, `pr-plan.ts` refuses: split the change (into a stack when stacking is allowed), or state why it cannot be split with `--accept-oversize <reason>` and put the reason in the body |
| `pull_requests.labels` | list of label names | none | Labels added when the pull request opens, such as `agent-authored`. Each must already exist in the repository |
| `pull_requests.title_format` | `conventional`, `free` | Derived (see [above](#what-is-derived-not-declared)) | Whether titles follow Conventional Commits. With squash merges the title becomes the trunk commit, so it matters |

### Stacking

A *[stacked pull request](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)* is based on another open pull
request's branch rather than the integration branch, so dependent work can be
reviewed before what it builds on merges. Stacks have a cost: any tool that
reads its settings from a pull request's base (an AI reviewer that loads its
policy from the integration branch, branch-protection rules, deploy previews)
has to work out where the stack finally lands, and a stack built by hand gives
it nothing to work from but the chain of branches.

- **`none`**: every pull request targets the integration branch.
  `pr-plan.ts open --stack-on <branch>` refuses. Dependent work waits for its
  predecessor to merge, or goes into the same pull request.
- **`native`**: dependent pull requests form a GitHub stack, which records
  each pull request's final target in GitHub's own stack metadata. The agent
  opens the pull request against its predecessor's branch, then links it with
  the [gh-stack](https://github.com/github/gh-stack) extension.
  `pr-plan.ts` reads the stacks GitHub already records (its Stacks API) and
  prints the link command: when the predecessor is the top of an existing
  stack, `gh stack link <stack number> <new>`, which appends and lets the
  extension carry every existing member forward, merged ones included;
  when no layer is in a stack yet,
  `gh stack link --base <integration branch> <bottom> … <predecessor> <new>`.
  Every pull request is given by its URL, never its number: the extension
  reads a number that is also a local branch's name as that branch, and
  pushes it.
  It refuses a predecessor below a stack's top (the extension only appends),
  a stack that lands on another branch, a chain that disagrees with the
  stack (its open members, bottom to top, must be exactly the chain of
  bases), a layer the extension will not add to a new stack (auto-merge
  enabled, or queued for merge), an append when a local branch has the
  stack's number as its name (the extension would read the number as that
  branch), and a missing extension; it fails when the Stacks API, the
  layers' eligibility, or whether such a local branch exists cannot be read. These are the checks the extension
  makes only after the pull request exists, so a refusal here keeps it from
  being created outside the stack.
  `max_stack_depth` counts every member the stack keeps, merged ones
  included, because the extension carries them all forward.
- **`branch`**: plain base-branch chaining, with no stack metadata. Tools
  must walk the chain themselves. `pr-plan.ts` warns when the repository
  does not delete head branches on merge, because then GitHub does not
  retarget the layer above a merged one, and the walk breaks at the merged
  layer until someone retargets it by hand.

For `native` and `branch`, `--stack-on` must name the head branch of exactly
one open pull request from this repository, whose chain of bases reaches the
integration branch; anything else is refused, because base-scoped tools could
not resolve it either.

## `drive`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `drive.validation_plan_command` | shell command | The plan is `gates.command` alone | drive-pr, fix-ci, resolve-conflicts, review, descar | Reads changed files (one per line) on stdin and prints the validation plan as JSON on stdout. The change-areas skill's resolver prints such a plan from the catalog: `bun <plugin>/skills/change-areas/scripts/resolve.ts --files - --format json`, or the repository's own [composer](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) around it |
| `drive.load_guard_command` | shell command | No load guard | drive-pr | Waits until the machine can take heavy checks |
| `drive.change_areas_catalog` | path, relative to the root or absolute | No catalog: `--area` unchecked, no area-based agent routing | drive-pr, do-item, review, decide, work-batch, change-areas, resolve-conflicts | The repository's [change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (YAML with an `areas:` map). The [change-areas](skills/change-areas/README.md) skill validates the whole catalog against [its schema](skills/change-areas/README.md#the-catalog) and resolves a change against it. The plugin reads each area's `paths` and `generated[].source` globs, `labels`, `tracker.labels` and `tracker.flags` (`linear:` is the older spelling of the `tracker:` block) and `agent`, through one reader that refuses an area whose globs, labels or `tracker` block are malformed, with the field at fault; `agent` and the rest of the area are passed through unchecked. `resolve-conflicts` also reads each area's `generated[].outputs` and `command` (see `resolve_conflicts.generated`). `determine_agent.ts --catalog` overrides it for one run |
| `drive.reviews_drafts` | `true`, `false` | Unknown | drive-pr, do-item | Whether the AI reviewer reviews draft pull requests. The drive uses it to explain a draft waiting for a review; `false` also makes new pull requests open Ready unless `pull_requests.open_as` says otherwise |
| `drive.max_rounds` | whole number ≥ 1 | `10` | drive-pr | The default round budget of a drive: how many review rounds it runs before it stops unconverged (exit `6`). The `--max-rounds` flag overrides it for one run. A value that is not a whole number of at least 1 stops the drive, unless the flag names the budget |
| `drive.escape_baseline_doc` | path, relative to the root | `docs/review-loop-baseline.md` | drive-pr | Document recording the human-judged defect-escape baseline that the loop-cost reports compare against |

## `ci`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `ci.required_checks` | list of distinct check names; `[]` means none | Derived from the protection and rulesets of the pull request's base, and of the branch its stack lands on; for changelog, of the integration branch | drive-pr, changelog | drive-pr: checks that must complete on the converged head before the drive certifies it. Required, and not empty, when `ci.hold_label` is set. changelog (`tag.ts`, `status.ts`): checks that must pass on a releasing commit before its version is tagged, `[]` tagging without any, read from the integration branch's `.config/jig.yaml` only, never from a person's file or the environment. Set, it wins over the branch's rules for both. Unset, and with no check the integration branch's rules require, tagging fails closed: no required checks known. Name only checks that run on the integration branch: one that runs only on pull requests never reports there, and its versions would wait for their tag forever |
| `ci.hold_label` | label | No hold: every push runs full CI | drive-pr | A label the repository's workflows honour by skipping expensive jobs on intermediate pushes; the drive removes it once review converges. See the [drive-pr README](skills/drive-pr/README.md); the workflow side is [M13's CI hold](https://github.com/jig-harness/jig/blob/main/modules/M13-pipeline-economy/README.md#7-hold) |

## `issue_tracker`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `issue_tracker.adapter` | adapter name | `github` | do-item, drive-pr, decide, work-batch | Which [tracker adapter](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) answers: `github` or `linear`. `github` (GitHub Issues) uses the signed-in `gh` command-line client, which also reads `GH_TOKEN` or `GITHUB_TOKEN`; with `JIG_GITHUB_GRAPHQL_URL` set it sends requests to that GraphQL endpoint (a GitHub Enterprise Server) with the token from `GH_TOKEN` or `GITHUB_TOKEN`. `linear` reads `LINEAR_API_KEY` or `LINEAR_API_TOKEN`, or uses a signed-in `linear` command-line client. A file that sets `issue_tracker.team` without `issue_tracker.adapter` (or with it empty) is refused, since the default adapter has no team: add `adapter: linear` |
| `issue_tracker.team` | team key such as `ENG` | **Required by the Linear adapter**; refused unless `issue_tracker.adapter` is set too | do-item, drive-pr, review, work-batch | Linear only: the key issue identifiers carry (`ENG` for `ENG-123`). GitHub Issues keys are `#123`, of the repository `issue_tracker.github.repository` names |
| `issue_tracker.states` | map from state key to the tracker's name | Each key title-cased (`in_progress` → `In Progress`) | do-item (status moves, which sub-issue states count as parked, and how a sub-issue state with no category is read), work-batch | The tracker's own names for the workflow states. Keys: `triage`, `backlog`, `todo`, `in_progress`, `in_review`, `ops_pending`, `done`, `canceled`, `duplicate`; any other key is an error. Each state needs its own name, except that `triage`, `backlog` and `todo` may share one, and so may `in_review` and `ops_pending` (a tracker with no operations state holds a merged issue in review), and `canceled` and `duplicate`. On GitHub Issues, `done`, `canceled` and `duplicate` are an issue closed as completed, not planned or duplicate, and each open state is the label (or, with `issue_tracker.github.states_from: project`, the board option) of that name; `todo` carries no label, so a new issue is in `todo` |
| `issue_tracker.github.repository` | `owner/name` | The repository the git remote (`repository.remote`, else `origin`) points to on github.com | do-item, drive-pr, file-issue, reflect, work-batch | GitHub Issues only: the repository whose issues the skills work on |
| `issue_tracker.github.states_from` | `labels` or `project` | `labels` | do-item, drive-pr, file-issue, reflect, work-batch | GitHub Issues only: where an open issue's workflow state is kept. `labels`: a label per state, named by `issue_tracker.states`. `project`: the option of a Projects board's single-select field; an open issue with no option is in `todo`, and one whose option names no open state is refused; the token then needs the `project` scope (`gh auth refresh -s project`) |
| `issue_tracker.github.project` | a board's web address, `https://github.com/orgs/<org>/projects/<n>` or `https://github.com/users/<user>/projects/<n>` | **Required when `states_from` is `project`** | do-item, drive-pr, file-issue, reflect, work-batch | GitHub Issues only: the board whose field holds the state. Moving an issue to an open state adds it to the board when it is not there |
| `issue_tracker.github.status_field` | field name | `Status` | do-item, drive-pr, file-issue, reflect, work-batch | GitHub Issues only: the board's single-select field that holds the state |
| `issue_tracker.github.priority_labels` | map from `urgent`, `high`, `medium`, `low` to a label | `priority: urgent`, `priority: high`, `priority: medium`, `priority: low` | do-item, drive-pr, file-issue, reflect, work-batch | GitHub Issues only: the label that carries each priority (1 to 4); an issue with none has no priority. Each priority needs its own label, which with `states_from: labels` is also no state's label |
| `issue_tracker.labels.epic` | label | `review.taxonomy.epic_label`, else `epic` | do-item, resolve-review-comments, drive-pr (fleet health), work-batch | Marks an issue whose sub-issues are worked one at a time |
| `issue_tracker.labels.hitl` | label | `hitl` | do-item, decide, work-batch | The human-in-the-loop flag; its facets are `<hitl>:<stakeholder>` |
| `issue_tracker.labels.manual_ops` | label | `manual-ops` | do-item, work-batch | A step a person performs outside the code; caps an epic at `ops_pending` |
| `issue_tracker.labels.followup` | label | `review.taxonomy.provenance_label`, else `pr-followup` | do-item, resolve-review-comments, drive-pr (fleet health), work-batch | Marks an issue filed from a review finding |
| `issue_tracker.labels.bug` | list of labels | `[bug, type:bug]` | do-item | Any of these marks a bug |
| `issue_tracker.labels.pattern_prefix` | text | `pattern:` | do-item, reflect, review-reflections | A recurring pattern's label is `<prefix><slug>`; a reflection class's issue is `<prefix><class>` |
| `issue_tracker.labels.batch_sizes` | list of labels | `[xs, small, medium]` | do-item, work-batch | Sizes whose issues the batch check may group into one pull request |
| `issue_tracker.labels.extractable_tails` | list of labels | `<hitl>:legal`, `<hitl>:tactical`, `<manual_ops>`, `<followup>` | do-item | Open sub-issues an epic may hand off instead of finishing |
| `issue_tracker.types` | map from a [work type](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) to a list of labels | `bug`, `feature`, `improvement`, `task` and `spike`; `bug` marked by `issue_tracker.labels.bug`, each other type by `<type>` and `type:<type>` | do-item | The repository's work types and the labels that mark each. Its keys are the type set: a default type left out is dropped with its row in `do_item.work_types`, and a type outside the default list needs a complete row there. A type name is lowercase letters, digits, `-` and `_`; `unknown` is never one. Refused: a label listed under two types (ignoring case), a label the GitHub adapter uses for a workflow state or a priority (it removes those from an issue's labels), an empty map, and `bug` naming other labels than `issue_tracker.labels.bug` when both are set. `determine_type.ts` types an item by the first of: one of these labels, the tracker's own issue type matched to a type name ignoring case (GitHub's issue types; Linear has none), the title's Conventional Commits prefix where `pull_requests.title_format` is `conventional` (`fix` bug, `feat` feature, `chore` and `docs` task, `refactor` and `perf` improvement); else the item is `unknown`. Labels of two types on one item also make it `unknown` |
| `issue_tracker.file_command` | text | Ask the user to file the issue | do-item, decide, resolve-review-comments, descar, github-actions, promote-memory, reflect, review-reflections | How an agent files a new issue by hand, such as a slash command. `/jig:file-issue` files it through the tracker scripts, with its labels checked against the label taxonomy |
| `issue_tracker.taxonomy` | path, relative to the root or absolute | `label-taxonomy.yaml` | file-issue | The repository's [label taxonomy](https://github.com/jig-harness/jig/blob/main/modules/M9-tasks-memory/README.md): every label an issue may carry, in families, with the rules between them. `file-issue` checks each issue's labels against it before writing, and refuses to file while it is missing or fails its lint |

## `do_item`

A section named `do_issue` (the skill's former name) is refused, not ignored:
`do-item` stops and asks for it to be renamed `do_item` (the fields are the
same), rather than running without the repository's routing and gates.

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `do_item.agents.default` | agent name | `general-purpose` | do-item | Agent that implements an issue no rule routes |
| `do_item.agents.integrator` | agent name | `do_item.agents.default` | do-item | Agent that coordinates when more than two agents match |
| `do_item.agents.catalog` | map from catalog agent name to agent | none | do-item | Translates the change-area catalog's `agent` values into the repository's agent names |
| `do_item.agents.codearea_areas` | map from issue label to area key | none | do-item, work-batch | Routes an issue to a change area by label; these labels name the area a batch is drawn from |
| `do_item.agents.labels` | map from issue label to agent | none | do-item, work-batch | Label routing when the catalog gives no answer |
| `do_item.agents.title_keywords` | map from keyword to agent | none | do-item | Last-resort routing on a case-insensitive title match |
| `do_item.scouts` | map from agent to a list of scouts | none | do-item | Scouts that run before each agent. The key is the **agent**, not a label |
| `do_item.gates` | list of `{labels, paths, skill}` | none | do-item | Review skills that must approve a change before it is pushed, when the issue carries one of the `labels` or the change touches one of the `paths` |
| `do_item.execution_plan_block` | name | `execution-plan-v1` | do-item | Name of the fenced block in an epic's description that holds its machine-readable execution plan |
| `do_item.work_types` | map from a work type to fields of its row in the depth table below | The table's defaults | do-item | How much each delivery station does for an item of each type. An entry overrides single fields and keeps the rest of the row; a type outside the default list must set every field. Refused: an entry for a type outside `issue_tracker.types`, an entry for `unknown`, a field the table does not have, and a value outside a field's set. do-item prints the type and its row when it picks up an item |

The routing order and the gates are explained in
[do-item's SKILL.md](skills/do-item/SKILL.md).

### The depth table

Each row says how much the delivery stations do for one work type. A type
lowers depth only where nothing else raises it: a flag label, a mandatory
review the change-area catalog names, a gate in `do_item.gates` and the
`hitl` label keep their force whatever the type. In this version do-item
derives an item's type and prints its row when it picks the item up; what
each station does is otherwise unchanged
([design](https://github.com/jig-harness/jig/blob/main/design/work-types.md)).

| Field | Values | `bug` | `feature` | `improvement` | `task` | `spike` |
|-------|--------|-------|-----------|---------------|--------|---------|
| `pre_scouts` | list of `pattern` (the pattern pre-scout), `spec` (the item's linked requirements) | `[pattern]` | `[spec]` | `[spec]` | `[]` | `[]` |
| `test_first` | `required` (a failing test before the change), `new_behaviour` (required for new behaviour), `as_needed`, `none` | `required` | `new_behaviour` | `as_needed` | `none` | `none` |
| `review_tiers` | list of review tiers `1`, `2`, `3` | `[1, 3]` | `[1, 2, 3]` | `[1, 2, 3]` | `[1]` | `[]` |
| `review_skip_lines` | the most changed lines at which the review is skipped, `never`, or `none` (no review to skip) | `20` | `never` | `20` | `50` | `none` |
| `change_note` | `required` (where the repository keeps a changelog), `not_required` | `required` | `required` | `required` | `not_required` | `not_required` |
| `batchable` | `yes`, `within_batch_sizes` (sizes in `issue_tracker.labels.batch_sizes`), `no` | `within_batch_sizes` | `no` | `within_batch_sizes` | `yes` | `no` |
| `autonomy` | `full`, `hitl` (a person decides the deliverable) | `full` | `full` | `full` | `full` | `hitl` |
| `pr_body_sections` | list of section names | `[reproduction, cause, fix]` | `[requirements_covered, left_out]` | `[before_and_after]` | `[what_changed]` | `[findings, recommendation]` |

An item whose type cannot be derived is `unknown`, which is not a row a
repository sets: it is computed from the effective rows as the strictest
value of each field. Its pre-scouts, review tiers and body sections are the
union of every row's, each default type's default row included,
`test_first` is `required`, the review is never
skipped, the change note is required, it is not batchable, and its autonomy
is `hitl`, since failing to derive a type does not show the item is not a
spike. An override that lightens one type cannot lighten `unknown`.

## `work_batch`

How `work-batch` sizes and ranks a batch of small issues for one pull
request. The labels it reads come from the sections above: the batchable
sizes and label roles from `issue_tracker.labels`, the repository, type and
context labels from `review`, the labels that name an area from
`do_item.agents.codearea_areas`, and the catalog's flags from
`drive.change_areas_catalog`.

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `work_batch.point_budget` | whole number ≥ 1 | `16` | work-batch | The main limit: the points a batch may cost. `--budget` overrides it for one run |
| `work_batch.size_points` | map from batchable size to a whole number ≥ 1 | `{xs: 1, small: 2, medium: 6}` | work-batch | What each batchable size costs. Its keys must be exactly `issue_tracker.labels.batch_sizes`; set it whenever those differ from the default sizes |
| `work_batch.max_items` | whole number ≥ 1 | `6` | work-batch | The item limit: how many issues one review round holds. `--limit` overrides it for one run |
| `work_batch.solo_flags` | list of labels | none | work-batch | Labels added to the solo-only flags, which are otherwise derived: `issue_tracker.labels.hitl` and its facets, `issue_tracker.labels.manual_ops`, and every catalog area's `tracker.flags`. No setting removes a derived one |
| `work_batch.sizes` | list of labels | none: the labelling-gap report is off, and the known sizes are the batchable sizes and `review.taxonomy.sizes` | work-batch | Every size label, batchable or not, so an issue with no size label can be told from one too large to batch, and two sizes on one issue are caught. Without it, a size label named nowhere (a `large` the repository never lists) is not recognised as a size, so `small` beside it reads as `small`. Must include every batchable size; `review.taxonomy.sizes` is always added to it |
| `work_batch.ranking.sizes` | map from batchable size to a whole number ≥ 0 | `{xs: 2, small: 1, medium: 0}` | work-batch | The score of each batchable size; a size it leaves out scores 0 |
| `work_batch.ranking.provenance` | whole number ≥ 0 | `3` | work-batch | The score of the follow-up label (`issue_tracker.labels.followup`) |
| `work_batch.ranking.shared_area_label` | whole number ≥ 0 | `1` | work-batch | The score of each shared area label an issue carries |

An unknown field in `work_batch` or `work_batch.ranking` is refused. The
[work-batch README](skills/work-batch/README.md) explains the budget, the
ranking and the solo-only flags.

## `routing`

Which [model tier](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
and which effort the agent that implements an item runs on: its
[route](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), derived
from the item's work type, its labels and the change-area catalog by rules
kept here as data. Routing is opt-in: without a `routing` section, do-item
derives and prints each route and applies none, so a repository sees what
the rules would choose before it turns them on. `routing: {}` declares the
section and accepts every default; a `routing` key left empty (YAML's null)
reads as absent. In this version do-item prints the route and forwards
nothing yet
([design](https://github.com/jig-harness/jig/blob/main/design/agent-routing.md)).

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `routing.types` | map from a work type to `{tier, effort}` | The table below | do-item | Each type's base tier (`execution` or `strategic`) and effort (`low`, `medium`, `high`, `max`). An entry overrides single fields and keeps the rest of the row; a type outside the default list must set both. Refused: an entry for a type outside `issue_tracker.types`, an entry for `unknown`, and a value outside the lists. Only these two tiers can be routed to: an implementer writes, which the Scout tier may not, and the Judgment tier is admitted per decision layer, never for every item of a type |
| `routing.raise.flags` | list of labels, or `catalog` | `catalog`: every flag the catalog's areas declare under `tracker.flags` | do-item | Flag labels that move the effort up one step |
| `routing.raise.sizes` | list of labels | The known sizes (`work_batch.sizes`, else `issue_tracker.labels.batch_sizes`, with `review.taxonomy.sizes`) outside `issue_tracker.labels.batch_sizes`; `[large]` where that leaves none | do-item | Size labels that move the effort up one step. A batchable size never raises by default |
| `routing.raise.reviews` | `true` or `false` | `true` | do-item | Whether an area with a mandatory review (`review.skills` naming a skill) among the areas the item's labels reach through `do_item.agents.codearea_areas`, and every area their `impliedBy` closure adds, moves the effort up one step |
| `routing.models` | map from a runtime (`claude-code`, `codex`) to `{execution, strategic}`, each the runtime's [family alias](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) | `claude-code: {execution: sonnet, strategic: opus}` | do-item | The only place a model name appears. A declared runtime row names both tiers and replaces that runtime's default; a runtime with no row gets no model, and its routes are recorded and not applied |
| `routing.efforts` | map from a runtime to a map from an effort to the runtime's name for it | Each effort as written | do-item | Where a runtime spells an effort differently |

Refused besides: an unknown field in `routing` or `routing.raise`, a name
that is more than one word (it would not read back from the route record),
and, where the repository has a [label taxonomy](#issue_tracker) its label
lint accepts, a declared raise list naming a label the taxonomy does not
declare. A default list is
never refused: a default label no item carries raises nothing. A refused
`routing` section stops do-item and says why; it is never read as absent.

### The routing table

| Field | `bug` | `feature` | `improvement` | `task` | `spike` |
|-------|-------|-----------|---------------|--------|---------|
| `tier` | `execution` | `execution` | `execution` | `execution` | `strategic` |
| `effort` | `medium` | `high` | `medium` | `low` | `high` |

An item whose type is `unknown`, or whose type has no row while `routing`
is undeclared, takes the highest tier and the highest effort any row names,
each default type's default row included, so an override that lowers one
type cannot lower it.

The raises, each class moving the effort up one step at most once however
many labels of the class the item carries, in this order: a flag label, a
mandatory review, a size label, and the human-in-the-loop label
(`issue_tracker.labels.hitl`) or one of its facets, counted once even where
the catalog also lists it as a flag. A catalog that is declared and cannot
be read is taken to flag the item where `routing.raise.flags` is `catalog`,
and to hold a mandatory review where `routing.raise.reviews` is on. The
effort stops at `max`, and a raise never moves the tier: an Execution type
that keeps needing `max` is a row a person moves to `strategic`, with the
route records showing it.

## `fleet_health`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `fleet_health.config` | path, relative to the root or absolute | `.config/fleet-health.yaml` | drive-pr | The fleet-health settings file, described [below](#the-fleet-health-file) |
| `fleet_health.snapshot_dir` | folder; `~` is expanded, relative paths resolve against the root | `~/.local/state/jig/dashboard` | drive-pr | Where the fleet-health snapshot is read from. `DEV_DASHBOARD_DIR` overrides it |

### The fleet-health file

The fleet-health sensor (`drive-pr`'s `fleet-health.ts`, and the
`fractal-metrics.ts` ledger and baselines) compares a window's *ceremony*
(review rounds, follow-ups, delivery-process issues) with its *progress*
(merged product work, closed acceptance criteria, accepted epics) and raises
suspicions when one outweighs the other. Its definitions and thresholds are
the repository's, in their own file, because a built-in threshold nobody
chose would be a confident answer to an unasked question. So this file is
stricter than the overlay: it must exist for the sensor to run, every key
below marked required must be present, and an unknown key is an error.

| Field | Type | Required | What it does |
|-------|------|----------|--------------|
| `version` | `1` | yes | Schema version |
| `window.days` | whole number, 1–366 | yes | Default window length in days (`--days` overrides it) |
| `progress.product_areas` | non-empty list of distinct change-area keys | yes | Change areas whose merged work counts as product progress |
| `progress.weights.merged_product_pr` | number ≥ 0 | yes | Progress units per merged pull request in a product area |
| `progress.weights.criterion_closed` | number ≥ 0 | yes | Progress units per closed acceptance criterion |
| `progress.weights.epic_accepted` | number ≥ 0 | yes | Progress units per accepted epic |
| `ceremony.free_rounds` | whole number ≥ 0 | yes | Review rounds per pull request that count as normal, not ceremony |
| `ceremony.weights.rounds_beyond_free` | number ≥ 0 | yes | Ceremony units per review round beyond the free ones |
| `ceremony.weights.followups_minted` | number ≥ 0 | yes | Ceremony units per review follow-up issue filed |
| `ceremony.weights.sdlc_issues_opened` | number ≥ 0 | yes | Ceremony units per issue opened against the delivery process itself |
| `ceremony.unmeasured` | map from unit name to reason | yes (may be `{}`) | Ceremony the sensor cannot measure, each with the reason stated |
| `signals.stuck_epic.days` | whole number, 1–366 | yes | Days without activity before a started epic counts as stuck |
| `signals.tail_blocked.done_share` | number 0–1 | no; default `0.8` | Share of an epic's children (abandoned ones left out) that must be delivered for it to count as tail-blocked |
| `signals.tail_blocked.max_open` | whole number ≥ 1 | no; default `2` | Most children that may still be open on a tail-blocked epic |
| `signals.ceremony_ratio.suspect_at` | number ≥ 0 | yes | Ceremony-to-progress ratio at which an epic is suspected |
| `signals.ceremony_ratio.high_at` | number ≥ `suspect_at` | yes | Ratio at which the suspicion is high. An epic with ceremony and no progress is raised at maximum severity |
| `signals.ceremony_ratio.min_ceremony` | whole number ≥ 1 | yes | Least weighted ceremony before an epic can be raised at all |
| `signals.followup_depth.suspect_at` | whole number ≥ 1 | yes | Follow-up chain depth (a follow-up of a follow-up …) at which a pull request is suspected |
| `signals.followup_depth.max_walk` | whole number, 1–20 | yes | Deepest chain walked |
| `signals.delivery_system_share.suspect_at` | number 0–1, or `null` | yes | Share of merged change in delivery-system areas at which to raise; `null` reports it without raising |
| `signals.review_carousel.min_rounds` | whole number, above `ceremony.free_rounds` | yes | Reviewed heads at which a pull request can be a review carousel |
| `signals.review_carousel.high_rounds` | whole number ≥ `min_rounds` | yes | Reviewed heads at which the suspicion is high |
| `signals.review_carousel.min_post_review_share` | number 0–1 | yes | Share of the change made after review began that marks a carousel |
| `lifecycle.cooldown_days` | whole number ≥ 0 | yes | Days a suspicion that a diagnosis comment closed stays closed before it can be raised again |
| `labels.epic` | label, or `null` | no; default the overlay's epic label (`issue_tracker.labels.epic` or `review.taxonomy.epic_label`), else `epic` | Label marking an epic |
| `labels.followup` | label, or `null` | no; default the overlay's explicitly declared follow-up label (`issue_tracker.labels.followup` or `review.taxonomy.provenance_label`); explicit `null`, or no label declared in either file, means follow-ups are not measured | Label marking a review follow-up |
| `labels.delivery_system` | label, or `null` | no; unset means not measured | Label a delivery-system change area and its issues carry |
| `labels.repositories` | list of labels | no; default the overlay's `review.taxonomy.repos`; none declared means orphan-risk is not measured | Labels that name a repository; an epic carrying none of them, with no children, project or owner, is an orphan risk |
| `ledger.label` | label, or `null` | no; default `labels.followup` | Label of the debt ledger `fractal-metrics.ts` reports |
| `ledger.project` | tracker project, or `null` | no | A project whose issues also belong to the ledger |
| `ledger.closed_state_types` | non-empty list of state types | no; default `[completed, canceled, duplicate]` | Tracker state types that close a ledger issue |
| `merge_conflicts.coverage_floor` | number 0–1 | no; default `0.9` | Minimum observed share of the scoreboard’s forge-listed merged PR cohort before `drive-pr` judges `merge_conflict_share`; unknown PRs must also leave both whole-cohort bounds at the same verdict |
| `baselines.<metric>.value` | number | per baseline | A recorded baseline for one scoreboard metric |
| `baselines.<metric>.source` | `{file, needle}` | no | The document recording that number and a substring that must still appear in it, so a stale baseline is caught |

`baselines.merge_conflict_share.value` records the share of observed merged pull requests that met a conflict, using the scoreboard’s PR window. Replay of the PR’s own merge ancestry and this clone’s live events establish conflicts. A clean observation additionally needs complete replay coverage and a forge timeline without force-pushes; silence in the live record does not establish it. The report states the unknown share and whole-cohort bounds, and withholds a verdict when their endpoints disagree. The default coverage floor keeps older fleet-health files readable.

Beside `stuck-epic` the sensor reports an **epic census** of the started epics,
read-only and never commented on an epic: `finished-but-open` (every child
closed, the epic open; it replaces `stuck-epic` for that epic),
`tail-blocked` (at least `signals.tail_blocked.done_share` delivered with at
most `signals.tail_blocked.max_open` children open; canceled and duplicate
children are left out of the share) and `orphan-risk` (no children, no
project, no assignee and none of `labels.repositories`). Each states that
closing an epic requires an accepting acceptance verdict or a recorded waiver.

The team key comes from `issue_tracker.team` and the change-area catalog from
`drive.change_areas_catalog`. The signal lifecycle and what a diagnosis
comment looks like are described in the header of
`skills/drive-pr/scripts/fleet-health.ts`.

## `verify`

The [evidence record](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(`shared/evidence.ts`): a check run through it is recorded against the exact
tree it ran on, with its exit, the test counts from its JUnit report and the
start and end of its output, so a claim that the check passed points at a run.
`bun <plugin>/shared/evidence.ts run -- <command>` records a run and
`bun <plugin>/shared/evidence.ts list` prints the records for the tree as it is
now; the script's header lists every flag. The `verify` skill, once built,
reads the same fields. Records and their output never leave the machine, and
only their owner can read them; the short block the script prints names the
command by a display name, never by its arguments, and gives the report's
counts, never its suite or case names. An unknown field in `verify` is
refused.

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `verify.store` | folder; `~` is expanded, relative paths resolve against the root | `~/.local/state/jig/evidence` | evidence (`shared/evidence.ts`; the `verify` skill when built) | Where the records are kept: `<store>/<repository>/<tree hash>/<command hash>/<run id>.json`, with the full output beside each; `<repository>` is the clone's folder name and a hash of its Git directory, so two clones of one name keep apart. A machine-local store: deleting it costs a re-run, never a decision, so it usually belongs in the user file. A folder inside the repository must be one Git ignores, or each run would change the tree it records |
| `verify.output_lines` | whole number ≥ 1 | `60` | evidence (`shared/evidence.ts`; the `verify` skill when built) | How many lines from the start and from the end of the output the record keeps |
| `verify.timeout_minutes` | whole number from 1 to 35791 (the longest a timer holds) | `30` | evidence (`shared/evidence.ts`; the `verify` skill when built) | The deadline of a run that `--timeout` does not set; a run that reaches it is ended with its whole process tree and recorded as timed out, never as a pass or a failure |
| `verify.retention_days` | whole number ≥ 1 | `30` | evidence (`shared/evidence.ts`; the `verify` skill when built) | How long records are kept. Checked when a record is written; removing older records is to be a kind of the resource collection runner ([`gc`](#gc)), which does not collect them yet, so until then nothing is removed |

## `reflection`

Session reflection ([reflect](skills/reflect/README.md) and
[review-reflections](skills/review-reflections/README.md)). The section's
presence in any layer turns reflection on; without it, the journal takes no
notes and no skill asks for a reflection. Since every repository writes to the
same store, it normally lives in the user layer (`~/.jig/jig.yaml`), which
turns reflection on for every repository on the machine; a repository's own
file can turn it on for everyone working in it, override the store, or turn it
off with `enabled: false`.

```yaml
reflection:
  path: ~/.jig/reflections
```

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `reflection` | mapping | Reflection is off | reflect, review-reflections, drive-pr, resolve-review-comments, do-item | Its presence turns reflection on |
| `reflection.enabled` | `true`, `false` | `true` when the section exists | reflect, review-reflections, drive-pr, resolve-review-comments | `false` turns reflection off: in a repository's file for that repository, or `JIG__REFLECTION__ENABLED=false` for one run |
| `reflection.store` | `filesystem`, `notion`, `github`, `command` | `filesystem` | reflect, review-reflections | Which store answers: the [filesystem store](skills/reflect/README.md#filesystem-store), the [Notion store](skills/reflect/README.md#notion-store), the [GitHub store](skills/reflect/README.md#github-store), or `reflection.command` |
| `reflection.path` | folder; `~` is the home directory, a relative path is the repository's | `~/.jig/reflections` (under `JIG_HOME`) | reflect, review-reflections | The filesystem store's folder |
| `reflection.command` | a command line, or a list of words | **Required** with `store: command` | reflect, review-reflections | The store command; the operation is appended to it. No shell runs it |
| `reflection.notion.database` | a Notion database id, or a link to it | **Required** with `store: notion` | reflect, review-reflections | The database `notion-store.ts init` created. The integration's secret is read from the `NOTION_TOKEN` environment variable, never from a file |
| `reflection.github.repository` | `owner/name` | **Required** with `store: github` | reflect, review-reflections | The repository whose issues hold the reflections, often a private one kept for them. Requests go through `gh`, signed in as it is; the account needs write access, and the repository a `jig-reflection` label (`check` names the command that creates it) |
| `reflection.journal` | file path | `<git-dir>/jig/reflection-journal.jsonl` | reflect, resolve-review-comments | The worktree's journal; a path git would track, or a file it already tracks, is refused. Parking still uses it when the section says `enabled: false` |
| `reflection.escalate_after` | whole number, at least 1 | `3` | reflect, review-reflections | The recurrence count at which a class is escalated to one tracker issue |
| `reflection.timeout_sec` | whole number of seconds, at most 86400 | `120` | reflect, review-reflections | The deadline for one store operation; `list` and `diagnose` get five times as long |
| `reflection.mode` | `quick`, `comprehensive` | `quick` | reflect | The reflection's default depth: what went wrong only, or also what worked and what could improve |

Escalation reads `issue_tracker.labels.pattern_prefix` (a class's issue is
labelled `<prefix><class>` and carries an owner marker, a
`Jig owner: <owner>` line with the owner percent-encoded, in its
description, which the lookup requires) and `issue_tracker.file_command`.

## `changelog`

Change notes and the changelog ([changelog](skills/changelog/README.md)). The
skill is on in a repository whose **own** `.config/jig.yaml` sets
`changelog.file`; without it every command says `not configured` and writes
nothing, and no skill asks for a note. Every field is repository-only, and the
skill reads the whole section from the repository's file alone: a value from the
user file or from a `JIG__CHANGELOG__*` variable is refused, never merged, so
neither can turn the skill on, or change what it enforces, in a repository that
did not adopt it. The branch check reads the section from the branch it compares
with (`git show <base>:.config/jig.yaml`), not from the branch's own tree, and
checks a branch that edits it against the section it proposes as well.

```yaml
changelog:
  file: CHANGELOG.md
  release_paths: [src/]
  version:
    files:
      - { path: package.json, key: version }
```

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `changelog.file` | path of a file, relative to the root | **Required**: absent, the skill is off | changelog | The changelog. Setting it turns the skill on. It must exist; the root itself, a folder path (`docs/`) and a path with a `..` segment are refused |
| `changelog.format` | `keep-a-changelog`, `common-changelog` | Detected from the file: an `## [Unreleased]` heading or a link to keepachangelog.com is Keep a Changelog, a link to common-changelog.org is Common Changelog; anything else, an empty file included, is refused with a request to set the field | changelog | The changelog's format: which change types a note lists, whether it has an Unreleased section, how an entry ends |
| `changelog.notes_dir` | folder, relative to the root | `changes` | changelog | The folder of change notes: the Markdown files directly in it, other than its `README.md`. The root itself (`.`, `./`) is refused |
| `changelog.version` | `{ files: [{ path, key }] }` or `{ tags: true }` | Derived: `package.json` `version`, `pyproject.toml` `project.version` (else `tool.poetry.version`) and `Cargo.toml` `package.version`, each only where it sits at the root and holds a written version; none left is an error asking for the field | changelog | Where the released version lives. `files`: JSON, TOML or YAML files each with the dotted `key` that holds the version (a plain `VERSION` file takes no key); all must agree. `tags`: the version is the changelog's newest release heading, before the first release the highest `<tag_prefix>x.y.z` tag, else `0.0.0` |
| `changelog.release_paths` | list of paths | `[]` | changelog | A change under one of these ships only in a release: its branch must carry a note that asks for one. A path ending in `/` is a folder; one without is that file or folder and what is under it, never another name that starts the same (`plugin` holds `plugin/x`, not `plugin-docs/x`). A file moved out of a path counts as a change to it |
| `changelog.note_paths` | list of paths | `[]` | changelog | A change under one of these must carry a note, with or without a release. Matched as `release_paths` are |
| `changelog.placeholders` | list of `{ files, from, to }` | `[]` | changelog | Text a file holds until the release knows its version: the release replaces `from` (one line) with `to`, with `{version}` filled in, in the files the `files` globs match. A glob that could match a file under `.github/workflows/` is refused |
| `changelog.after_version` | shell command | No command | changelog | Run from the root after the release step changes the version and before it deletes the notes, for files that repeat the version (a lock file: `npm install --package-lock-only`, `cargo update --workspace`, `uv lock`); its changes go into the release commit. Inside a CI job (any of `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TF_BUILD` or `JENKINS_URL` set to something but `false` or `0`) it runs only when the job sets `JIG_AFTER_VERSION_IN_CI=1`, since it is the repository's own command. The skill's action sets it on its release step only, which the workflow template runs in the `release` job, which holds no key; the job that pushes the release runs nothing from the repository. The branch check's reproduction of a release pull request leaves it out |
| `changelog.unreleased` | `write`, `wait` | `write`; `wait` with `release.push: pull-request` | changelog | Keep a Changelog only: whether a note without `release` is written under Unreleased after its own merge (`write`) or waits for the next release (`wait`), which saves a commit and a CI run per merge. `release.push: pull-request` refuses `write` |
| `changelog.authors` | `true`, `false` | `true` | changelog | Common Changelog only: `false` leaves the authors out of each entry |
| `changelog.tag_prefix` | text | `v` | changelog | What a version's tag puts before it |
| `changelog.release.push` | `direct`, `pull-request` | `direct` | changelog | How the release reaches the integration branch: the workflow template's `push` job pushes the release commit onto it (`direct`) or force-pushes it to `release.branch` and opens or updates the release pull request (`pull-request`, which refuses `unreleased: write`). The branch check reads it from the base to recognise a release pull request; `release-access.ts` checks what the mode needs of the branch rules; `release.ts --json` prints it for the workflow |
| `changelog.release.branch` | branch name | `changelog-release` | changelog | `pull-request` mode: the branch the release pull request comes from, regenerated from scratch on every push to the integration branch. A pull request from it is checked as a release pull request (the base's value counts); `release-access.ts` checks that the App can create and force-push it |

The integration branch is not a field of this section: it is
`repository.base_branch`, else the hosting service's default branch (in a CI
job from the event that started it; elsewhere from `origin/HEAD`, then
`gh repo view`). The branch check's comparison base is never
`repository.base_branch`; see
[the skill's scripts reference](skills/changelog/scripts/README.md#the-branch-check).

## `code_stats`

How the [code-stats](skills/code-stats/README.md) skill classifies the
repository's files. Every field is optional: without the section the skill
uses its built-in detection, the test files its test runners' configuration
names ([read before this section](skills/code-stats/README.md#test-runner-configuration):
jest, vitest, pytest, Gradle and Maven), and the default areas, and the
fields fix what those get wrong. Every field is repository-only. A value the skill
cannot use (an unknown kind, a malformed glob, an empty or repeated area
name, a value of the wrong type, an unknown key) is refused with a message
naming the field.

```yaml
code_stats:
  areas:
    - name: product
      description: The shipped applications and their packages
      paths: ["apps/**", "packages/**"]
    - name: content
      paths: ["content/**"]
      content: true
  default_area: production
  kinds:
    test: ["scripts/smoke-*.sh"]
  modules: ["apps/*", "packages/*"]
```

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `code_stats.areas` | list of `{name, description?, paths: [globs], content?: true or false}`; globs are relative to the root (`**`, `*`, `?`, `{a,b}`, `[...]`) | The default areas below | code-stats | What each file is for, in order: the first rule whose glob matches names a file's area. The list replaces the default areas whole. `content: true` makes YAML, JSON and other configuration files in that area count as data. A name holds no `/` |
| `code_stats.default_area` | area name | `production` | code-stats | The area of a file no rule matches; such a file counts as unclassified |
| `code_stats.kinds` | map of kind (`code`, `test`, `docs`, `config`, `data`, `generated`, `fixture`, `asset`, `vendored`, `other`) to a list of globs | none: built-in detection and the test runners' configuration | code-stats | Kinds checked before built-in detection and the test runners' configuration, in the order written; the first glob that matches decides |
| `code_stats.modules` | list of globs naming module folders | Detected from the [workspace manifests](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (pnpm, npm, Yarn or Bun workspaces, `go.work`, Cargo, Gradle, uv), else the top folders | code-stats | The module folders; a file belongs to the deepest one that holds it |
| `code_stats.classify_command` | shell command | none | code-stats | The last layer, a [classify command](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): run once from the root with the tracked paths on standard input, one per line; prints JSON lines `{"path", "area"?, "kind"?, "language"?, "module"?}` whose values override every other layer. A non-zero exit, a line it cannot read, an untracked path, or an unknown area or kind fails the report ([contract](skills/code-stats/README.md#the-classify-command)) |

The default areas, in order:

| Area | What it holds |
|------|---------------|
| `scaffolding` | AI agent scaffolding: agent instructions, skills, rules and agent tool settings |
| `ci` | CI pipelines: workflow and pipeline definitions |
| `build` | Build definitions and build tooling: the files of a dedicated build tool (see the build tool table) |
| `database` | Database schema and migrations, by the tool or convention that writes them (see the database table) |
| `ops` | Deployment and infrastructure: Terraform, Helm, Kubernetes, Ansible, containers and compose files |
| `tools` | Internal developer tooling that does not ship: tools/, scripts/, bin/, hack/ |
| `docs` | Documentation: docs/, doc/, root-level documents and licence files |
| `repo-config` | Repository configuration: root-level files that are not code (manifests, lockfiles, linter and editor settings) and the .github/ files no other area takes (CODEOWNERS, issue templates, dependency-update settings) |
| `production` | Everything no other area takes (the default area) |

The [skill's README](skills/code-stats/README.md#default-areas) lists each
area's paths, the build tools and the database conventions.

## Procedure skills

The procedure skills (`review`, `fix-ci`, `github-actions`, `adr`, `descar`,
`promote-memory`, `programmatic-execution`, `design-brief-builder`, `decide`,
`explain`, `resolve-conflicts`, `audit`) detect
what they need from the repository; set a field only when detection picks
the wrong thing. `programmatic-execution` and `audit` read no field of their
own; `audit` checks all the others.

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `adr.directory` | folder, relative to the root | Detected: the first existing of `docs/adr`, `docs/adrs`, `doc/adr`, `docs/decisions`, `docs/architecture/decisions`, `doc/architecture/decisions`, `adr`, `decisions`; none means no records yet, and `decide` and `explain` then use `docs/adr` | adr, review, decide, explain | Where the decision records live. `decide` searches them for precedent, and `decide` and `explain` resolve a bare `ADR-NNNN` citation there when they check a sheet's freshness. `adr` and `review` require a configured folder to exist; `decide` and `explain` do not check, and find no records in a missing one |
| `adr.rules_file` | path, relative to the root | Detected: the one tracked `adr-rules.yaml`, `adr-rules.yml`, `.adr-rules.yaml` or `adr-rules/rules.yaml` (or `.yml`), outside test fixtures and templates; several matches are an error | adr, review | The machine-readable decision-rules catalog. A configured file must exist |
| `descar.lint_command` | shell command taking document paths | Detected: the repository's copy of M4's scar lint; else the document is checked by hand | descar | Lint that finds review scars in documents |
| `promote_memory.lint_command` | shell command; `{dir}` and `{file}` stand for the memory folder and file | none: the check is done by hand | promote-memory | Checks one agent memory against the repository; exit 0 means clean |
| `promote_memory.target_dir` | folder, relative to the root | `docs/retrospection` | promote-memory | Where promoted pages go, in `YYYY/MM/` below it |
| `fix_ci.regenerate_commands` | list of shell commands | none: the agent finds the command | fix-ci | Commands that regenerate committed generated files a CI check compares |
| `resolve_conflicts.generated` | list of `{paths: [globs relative to the root], command: shell command}`; globs match as the change-area catalog's do (`**`, `*`, `?`, `{a,b}`, `[...]`) | none: the change-area catalog's `generated[].outputs` (when `drive.change_areas_catalog` is set), then the built-in lockfile table apply | resolve-conflicts | Files that are regenerated, never hand-merged, when they conflict, and the command that rebuilds them (run from the root). The repository's `.config/jig.yaml` and the catalog are read from the git index, as the commit carries them, so a change to either takes effect once it is staged (a file `JIG_OVERLAY` names is read the same way when it lies inside the repository; the user and environment layers and a configured path outside the repository are read as they are; an index link whose target leaves the repository is refused, never read from disk). For files the change-area catalog does not declare: the catalog's `generated[].outputs` (literal file paths, matched exactly) and `command` are read as entries of this list, so a generator declared there needs no copy here. A path is classified by the first match of this list, then the catalog, then the built-in lockfile table, so an entry here overrides both. Unknown keys are refused |
| `resolve_conflicts.hotspot_min_merges` | whole number, 1 or more | `3` | resolve-conflicts | The history report (`history.ts`) names a path a conflict hotspot when it conflicted in at least this many of the merges it replayed in its range |
| `resolve_conflicts.obligations` | list of `{check: nonempty text, command?: nonempty shell command}` | none | resolve-conflicts | Checks the agent applies to the entire resolved staged diff, including auto-merged hunks. Optional commands run from the repository root during validation, only while every tracked file matches the staged tree; failure, or a command changing the staged tree or a tracked file (which also stops the commands after it), blocks completion and is included in the report. Text still requires agent inspection when a command passes. Unknown keys are refused. Each command has a 120-second deadline, overridden by the positive whole-second `RESOLVE_CONFLICTS_COMMAND_TIMEOUT` environment variable |
| `github_actions.conventions_doc` | path, relative to the root | Searched for in the instructions and docs; else generic guidance | github-actions | The document describing the repository's workflows and their conventions |
| `design_brief.kit` | folder, relative to the root | Detected: a tracked folder ending in `design-kit` or `design_kit` | design-brief-builder | The design kit: voice, colours and type, rubric, component previews, logo |
| `design_brief.design_language` | path, relative to the root | Detected: the first tracked `*design-language*.md` or `*design-system*.md` | design-brief-builder | The written design canon |
| `design_brief.prototypes` | folder, relative to the root | none: the agent asks | design-brief-builder | Where finished design bundles land, one folder per flow |
| `design_brief.handback.forbidden_terms` | list of literal strings | `[]` | design-brief-builder | Forbidden or retired text; the bundle README may extend it. Matching is case-insensitive |
| `design_brief.handback.widths` | nonempty list of distinct positive integer widths in pixels | required for handback | design-brief-builder | Viewport widths at which every bundle scenario is rendered and checked for horizontal overflow |
| `design_brief.handback.rubric` | path, relative to the root | required for handback | design-brief-builder | The consumer's scoring rubric; must exist |
| `design_brief.handback.scorecard` | path, relative to the root | required for handback | design-brief-builder | The review scorecard; must exist, state one bar outcome and name the export base it reviewed |
| `design_brief.handback.browser_executable` | executable path, relative to the root or absolute | required for handback | design-brief-builder | Installed Chrome or Chromium used for headless rendering; a missing browser fails the checklist |
| `sheets.repositories` | map of repository name to folder, relative to the root or absolute; names are lowercase letters, digits, `-` and `_`, starting with a letter | none: a citation qualified with a repository name (`beta:ADR-0002`) is refused | decide, explain | The clones of the other repositories a sheet cites. A sheet qualifies such a citation with the name (`beta:apps/api/auth.ts`, `beta:ADR-0002`) and records the commit its facts were checked at in `verifiedAt.repositories`; the freshness guard compares the cited file at that commit with the clone's working tree, finds that repository's ADRs in the clone as it finds this repository's when `adr.directory` is not set (the first candidate folder that exists, else `docs/adr`), and refuses a name with no entry here, no recorded commit, or a folder that is not the top of a git clone. A bare `ADR-NNNN` always means this repository. Where the clones sit differently on each machine, leave the name out of the repository file and set it in the user layer (`~/.jig/jig.yaml`, absolute paths): a name the repository file sets overrides the user layer's |
| `decide.policy_files` | list of paths, relative to the root | `[AGENTS.md]` | decide | Instruction files whose `##` sections are standing policy |
| `decide.rules_directory` | folder, relative to the root | `.claude/rules` | decide | Conditional rules, one rule per `.md` file |
| `decide.glossary_file` | path, relative to the root | `CONTEXT.md` | decide, explain | The canonical vocabulary, as `**Term**:` lines each followed by an `_Avoid_:` line |
| `decide.architect_agent` | agent name | A briefed general-purpose subagent | decide | The subagent that rules on a dilemma; a name the agent tool does not know falls back to the default |
| `decide.escalation_labels` | list of labels | none | decide | Labels added beside `issue_tracker.labels.hitl` and its facets when a call is escalated |
| `explain.figure_build_command` | shell command; the figure's stem is appended | none: explainers have no figures | explain | Builds one explainer figure |

Each skill's `SKILL.md` explains how its fields are used.

## Environment variables

These are set per machine or per run, not committed:

| Variable | What it does |
|----------|--------------|
| `JIG_OVERLAY` | Path of the configuration file to read instead of the repository's own |
| `JIG_CONSUMER_ROOT` | The repository root, instead of the nearest folder holding `.git` |
| `JIG_HOME` | The folder holding the user layer's `jig.yaml`, instead of `~/.jig` |
| `JIG_USER_LAYER` | `off` leaves the user layer out (see [configuration layers](#configuration-layers)) |
| `JIG_AFTER_VERSION_IN_CI` | `1` lets `changelog.after_version` run inside a CI job (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TF_BUILD` or `JENKINS_URL` set); set it only in a job that holds no secret |
| `JIG_CODE_STATS_COMMAND_TIMEOUT_SEC` | Seconds `code_stats.classify_command` may run before it is stopped and the report fails; 300 by default |
| `JIG_AFTER_VERSION_TIMEOUT_SEC` | Seconds `changelog.after_version` may run before it is stopped and the release fails; 1800 by default |
| `JIG__<SECTION>__<FIELD>` | Sets one field for this run, over every file (see [configuration layers](#configuration-layers)) |
| `LINEAR_API_KEY`, `LINEAR_API_TOKEN` | Credentials for the Linear adapter |
| `DRIVE_PR_BASE_BRANCH`, `DRIVE_PR_REVIEWER_APP`, `DRIVE_PR_REVIEWER_CHECK`, `DRIVE_PR_STICKY_MARKER`, `DRIVE_PR_SHA_MARKER` | Override the matching field for one run |
| `DRIVE_PR_ATTACH` | `off` makes `drive.ts` drive the working tree as it stands, without attaching the pull request to it first (for a harness that prepares its own trees), and `attach-pr.ts --place` choose the tree without attaching; `on` or unset attaches ([which tree drives a PR](skills/drive-pr/README.md#which-working-tree-drives-it)) |
| `DRIVE_PR_STATE_DIR` | State root; rounds, locks and leases live in its `<clone-key>/` subdirectory. An inherited resolved leaf is also accepted. Flat legacy state refuses until explicitly relocated. |
| `JIG_VERIFICATION_FIT_LOG` | Where verification-fit verdicts are logged |
| `DEV_DASHBOARD_DIR` | Overrides `fleet_health.snapshot_dir` |
| `JIG_REVIEW_TRIAGE_CONFIG` | The [review-triage file](#the-review-triage-file) to read instead of `.config/review-triage.yaml` |
| `JIG_GH_CACHE_DIR` | Where cached GitHub answers are kept; default `~/.cache/jig/gh-cache` |
| `JIG_GH_CACHE` | `off` disables that cache |
| `GH_CALL_TIMEOUT` | Seconds one `gh` call may take; default 30 |
| `JIG_LOG` | How much the scripts' diagnostics say on standard error: `error`, `warn` (the default), `info` or `debug`. At `debug` a failing script also prints the stack of the failure and its causes, with the last 4,096 bytes of a failed command's error output where the failure carries it (`resolve-review-comments`' `gh` calls), and an error dropped on purpose is printed with the reason |
| `JIG_LOG_FORMAT` | `text` (the default) writes `<script>: <message>`; `json` writes one JSON object per line with the time, level, script, message and fields |
| `JIG_TRACE` | `1` enables [trace spans](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) for drive passes, waits and commands; files are written under `~/.local/state/jig/traces/<date>/` and `reap-state.ts` reaps trace days older than 14 days |
| `JIG_TRACE_FILE` | Enables tracing to this JSON lines file instead of the default trace directory; child processes inherit the same destination |
| `TRACEPARENT` | Carries the active trace and parent span to child processes; set by the runtime when tracing is enabled |
| `AWAIT_ROUND_CHECKS_MAX_AGE` | Seconds a still-waiting read of a pull request's checks may be reused while nothing on GitHub changed; default 300, `0` always reads |
| `JIG_TURN_BUDGET`, `JIG_TURN_BUDGET_MARGIN`, `JIG_TURN_BUDGET_REFIRE` | The turn-budget hook's cap (default 1000; `0` turns the hook off), the margin before it at which the hook warns (default 50), and how often it warns again (unset or `0`: once more when half the margin remains) |
| `JIG_TURN_BUDGET_STATE_DIR` | Where the turn-budget hook keeps its per-session state; default `jig-turn-budget` under the temporary directory |
| `JIG_REFOCUS` | `1` or `0` puts `do-item`'s intent-chain snapshot in the Refocus calibration's on or off arm; unset, odd issue numbers are on |
| `BASH_MAX_TIMEOUT_MS` | Claude Code's own variable, not Jig's: the longest `timeout` an agent may give a background command in an unattended session, 2 hours unless raised. Set it to `28800000` so a drive can outlast 2 hours (see [the background time limit](skills/drive-pr/README.md#the-background-time-limit)) |
| `DRIVE_PR_*` (others) | Round limits, timeouts and repair budgets; listed in the [drive-pr README](skills/drive-pr/README.md) |
| Others | A few knobs of a single skill, such as `REFLECT_THRESHOLD` of `resolve-review-comments`, are described where that skill's `SKILL.md` uses them |

## `clones` (user file only)

Where this machine keeps a clone of another repository, so a session in one
repository can arm the drive of a pull request in another
(`/jig:drive-pr owner/name#N`, or the pull request's URL). Only the user file
(`~/.jig/jig.yaml`) or an environment variable may set it: a repository's own
file, shared by everyone who clones it, cannot know where this machine keeps
anything, and refuses the field with an error naming it.

```yaml
clones:
  example/api: ~/work/api
  example/web: /srv/checkouts/web
```

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `clones` | map of `owner/name` to a local clone path, absolute or starting with `~/` | No clone is known: arming another repository's pull request prints the command to run in a checkout of it | drive-pr | The drive is armed in that clone's primary checkout, as for a pull request with no working tree: in the tree that holds the pull request, else in a new one under that repository's `gc.worktree_roots`. The clone must be a checkout of the repository its key names. Keys compare without regard to case |

## `gc`

The resource collector reads repository declarations separately from machine
policy. The audit uses the same declaration validator as `jig gc`. No shell
command can be registered as a collection kind.

| Field | Type | Default / meaning | Read by |
|-------|------|-------------------|---------|
| `gc.kinds` | distinct string list | Empty; supported repository kinds: `tool-state`, `scratch`, `worktrees` | audit, gc |
| `gc.worktree_roots` | distinct path list | Empty; roots containing the tool's worktrees, relative to the repository or absolute. `drive-pr` creates the working tree for a pull request that has none under the first root | audit, gc, drive-pr |
| `gc.scratch_prefixes` | distinct path list | Empty; path prefixes of scratch directory names, relative to the repository or absolute; a filesystem root is refused | audit, gc |

A collecting run fetches `.config/jig.yaml` from the remote URL and base branch
recorded at install. It intersects that declaration with the confirmed kinds,
roots and prefixes. Changes in a checkout, environment overrides, a changed
remote URL, and newly widened base declarations cannot grant deletion authority.
A report reads the checkout and names that source. An uninstalled repository
can be reported but cannot be collected.

### The machine's collection policy

These settings live only in the user file (`$JIG_HOME/jig.yaml`, default
`~/.jig/jig.yaml`); they cannot be set by a repository or environment override.
Run `bun --no-env-file --config=<plugin>/gc/bunfig.toml <plugin>/jig.ts gc install` to review the proposed entry, then repeat
with `--yes` to confirm it and install the scheduler. Installation must run
from the installed plugin copy, outside a Git checkout.

| Setting in the user file's `gc` section | Default / meaning |
|----------------------------------------|-------------------|
| `repositories` | Empty; installer-written entries containing `path`, `remote`, `remote_url`, `base_branch`, and `bounds` (the confirmed declaration) |
| `disabled` | Empty; kinds the machine will skip; cannot enable undeclared repository kinds |
| `idle_days` | Mapping of repository kind to idle guard, default 7 days; allowed range 7–365, so machine policy can only tighten the default |
| `receipts` | `false`; enable collection of old receipts |
| `receipts_days` | 30; positive days to retain receipts; each kind's latest receipt is always kept |
| `hour` | 4; local hour (0–23) for the daily scheduled run |
| `collect_day` | 0; local weekday (Sunday 0 through Saturday 6) on which the daily run collects |
| `min_free_bytes` | 0, disabled; collect on other days when available space in the home filesystem falls below this threshold |

The job records Bun's executable, the installed command's path, `HOME`,
`PATH`, `JIG_HOME`, and any explicit `TMPDIR`, `LOCK_ROOT` or `LOCK_NAME`.
Collection uses the same machine-wide heavy-run lock as gate runs. Scheduled
and child Bun invocations use the plugin's trusted configuration and disable
checkout environment files and preloads.
Report-only runs also write receipts, under
`~/.local/state/jig/gc/<date>/<run-id>.json`. `gc receipts` lists them;
`gc receipts <date>` lists a day and `gc receipts <run-id>` prints a run.
Use `gc --json` for the receipt schema on standard output.

The available collectors and remaining rollout work are in
[the collector's README](gc/README.md).

## Complete example

Every section, with values a typical repository might set. Copy only what
differs from the defaults.

```yaml
gc:
  kinds: [tool-state]
  worktree_roots: [../worktrees]
  scratch_prefixes: [/tmp/example-test.]
gates:
  command: make check                    # required by resolve-review-comments
review:
  bots: ["example-review[bot]"]
  deferral_team: ENG
  repo_label: web
  repo_slug: example/web
  job_pattern: "^AI review"
  required_checks: ["AI review"]
  scanner_apps: [sonarqubecloud]
  taxonomy:
    types: [bug, feature, chore, docs]
    repos: [web, api]
    sizes: [xs, small]
    categories: [correctness, security, tests, docs, style]
    context_prefixes: ["area:"]
    ownership_prefixes: ["team:"]
    provenance_label: pr-followup
    epic_label: epic
  reviewer_app: example-review
  reviewer_check_pattern: "^ai[ _-]?review(\\s*\\(.+\\))?$"
  sticky_marker: "<!-- ai-code-review -->"
  reviewed_sha_marker: ai-reviewed-sha
  severity_formats:
    - login: example-linter[bot]
      shape: badge                       # bold-token | badge | html-badge | pipe-fields | icon-fields
      severities: { Sev1: blocker, Sev2: high, Sev3: medium, Sev4: low }
repository:
  base_branch: develop                   # default: the repository's default branch
  remote: upstream                       # default: origin
pull_requests:
  stacking: branch                       # none | native | branch
  max_stack_depth: 4
  open_as: draft                         # draft | ready
  mark_ready: 1                          # after round N | converged | never
  branch_name: "feature/{key_lower}-{slug}"
  issue_link: closes                     # closes | refs | none
  size_budget: 600
  labels: [agent-authored]
  title_format: conventional             # conventional | free
drive:
  validation_plan_command: "<your plan command>"   # changed files on stdin, JSON plan on stdout
  load_guard_command: "<your load-guard command>"  # returns once the machine can take heavy checks
  change_areas_catalog: docs/change-areas.yaml
  reviews_drafts: true
  max_rounds: 10                         # default round budget of a drive; --max-rounds overrides
  escape_baseline_doc: docs/review-loop-baseline.md
ci:
  required_checks: [build, test]
  hold_label: ci:hold
issue_tracker:
  adapter: linear                        # or github, the default
  team: ENG                              # Linear only: required by the Linear adapter
  file_command: /jig:file-issue
  taxonomy: docs/label-taxonomy.yaml
  states:
    triage: Triage
    backlog: Backlog
    todo: Todo
    in_progress: In Progress
    in_review: In Review
    ops_pending: Ops Pending
    done: Done
    canceled: Canceled
    duplicate: Duplicate
  labels:                                # label role -> the tracker's label
    epic: epic
    hitl: hitl                           # facets: hitl:<stakeholder>
    manual_ops: manual-ops
    followup: pr-followup
    bug: [bug, type:bug]
    pattern_prefix: "pattern:"
    batch_sizes: [xs, small, medium]
    extractable_tails: [hitl:legal, hitl:tactical, manual-ops, pr-followup]
  types:                                 # work type -> the labels that mark it
    bug: [bug, type:bug]                 # default: labels.bug
    feature: [feature, type:feature]
    improvement: [improvement, type:improvement]
    task: [task, type:task, chore]
    spike: [spike, type:spike]
  github:                                # read by the github adapter only
    repository: acme/app                 # default: the git remote's
    states_from: project                 # default: labels
    project: https://github.com/orgs/acme/projects/1
    status_field: Status
    priority_labels:
      urgent: "priority: urgent"
      high: "priority: high"
      medium: "priority: medium"
      low: "priority: low"
do_item:
  agents:
    default: general-purpose
    integrator: integrator
    catalog: { api: backend-dev }
    codearea_areas: { "area:billing": billing }
    labels: { frontend: frontend-dev }
    title_keywords: { migration: backend-dev }
  scouts:
    backend-dev: [schema-scout, api-scout]
  gates:
    - { labels: [db-migration], paths: ["migrations/**"], skill: db-migration-review }
  execution_plan_block: execution-plan-v1
  work_types:                            # fields of the depth table to override
    task: { review_skip_lines: 80 }
work_batch:
  point_budget: 16
  size_points: { xs: 1, small: 2, medium: 6 }   # keys: exactly issue_tracker.labels.batch_sizes
  max_items: 6
  solo_flags: [privacy-review]           # added to the derived solo-only flags
  sizes: [xs, small, medium, large, xl]
  ranking:
    sizes: { xs: 2, small: 1, medium: 0 }
    provenance: 3
    shared_area_label: 1
routing:                                 # absent: routes derived and printed, none applied
  types:
    feature: { effort: max }
  raise:
    flags: catalog
    sizes: [large, xl]
    reviews: true
  models:
    claude-code: { execution: sonnet, strategic: opus }
  efforts:
    codex: { max: xhigh }
fleet_health:
  config: .config/fleet-health.yaml
  snapshot_dir: ~/.local/state/jig/dashboard
verify:
  store: ~/.local/state/jig/evidence     # usually set in the user file
  output_lines: 60
  timeout_minutes: 30
  retention_days: 30
adr:
  directory: docs/adr
  rules_file: docs/adr/rules.yaml
sheets:
  repositories:
    beta: ../beta
descar:
  lint_command: "bun scripts/check-descarring-scars.ts"
promote_memory:
  lint_command: "<your memory lint> --dir {dir} --file {file}"
  target_dir: docs/retrospection
fix_ci:
  regenerate_commands:
    - bun run generate:api
resolve_conflicts:
  generated:
    - paths: ["src/generated/**"]
      command: bun run generate
  hotspot_min_merges: 3                 # default: 3
  obligations:
    - check: Preserve the repository's validation guards in every resolved hunk.
    - check: The complete resolved result passes its configured checks.
      command: bun run gates
github_actions:
  conventions_doc: docs/ci.md
design_brief:
  kit: docs/design-kit
  design_language: docs/design.md
  prototypes: design/prototypes
  handback:
    forbidden_terms: [Retired Example]
    widths: [390, 768, 1440]
    rubric: docs/design-kit/rubric.md
    scorecard: design/prototypes/review-scorecard.md
    browser_executable: /usr/bin/chromium
decide:
  policy_files: [AGENTS.md]
  rules_directory: .claude/rules
  glossary_file: CONTEXT.md
  architect_agent: architect
  escalation_labels: [agent:architect]
explain:
  figure_build_command: "<your figure build command>"
reflection:
  enabled: true
  store: filesystem
  path: ~/.jig/reflections
  command: "<your store command>"
  notion:
    database: 0123456789abcdef0123456789abcdef   # the id init printed, or a link
  github:
    repository: example/reflections      # owner/name
  journal: .scratch/reflection-journal.jsonl
  escalate_after: 3
  timeout_sec: 120
  mode: quick
changelog:
  file: CHANGELOG.md                     # setting it turns the changelog skill on
  format: keep-a-changelog               # default: detected from the file
  notes_dir: changes
  version:                               # default: derived from package.json, pyproject.toml, Cargo.toml
    files:
      - { path: package.json, key: version }
  release_paths: [src/]                  # a change here needs a note that asks for a release
  note_paths: [docs/]                    # a change here needs a note
  placeholders:
    - files: ["docs/*.md"]
      from: "since: next"
      to: "since: {version}"
  after_version: npm install --package-lock-only
  unreleased: write                      # Keep a Changelog only: write | wait
  authors: true                          # Common Changelog only
  tag_prefix: v
  release:
    push: direct                         # direct | pull-request
    branch: changelog-release
code_stats:
  areas:                                 # ordered, first match wins; replaces the default areas
    - name: product
      description: The shipped applications
      paths: ["apps/**", "packages/**"]
    - name: content
      paths: ["content/**"]
      content: true                      # YAML and JSON here are data
  default_area: production
  kinds:
    test: ["scripts/smoke-*.sh"]
  modules: ["apps/*", "packages/*"]      # default: from the workspace manifests
  classify_command: "<your classify command>"   # paths on stdin, JSON lines on stdout
```
