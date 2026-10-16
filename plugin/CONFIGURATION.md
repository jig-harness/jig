# Configuration reference: `.config/jig.yaml`

The Jig skills hold the procedure; each repository holds its own
values. Without one place listing those values, a repository adopts a skill
by trial and error: an agent improvises what the repository never stated (how
to name a branch, whether pull requests may stack), and a
misspelt field silently keeps its default. This document lists every field
the skills read, its type, what it does, what happens when it is absent, and
which skill reads it. It is the complete reference; the skill READMEs explain
the behaviour behind each field.

The file is the repository's [consumer overlay](../GLOSSARY.md): its own
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
[`fleet_health`](#fleet_health) ·
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
  (including each `generated` entry) and `reflection`. In `review.taxonomy` every
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
[configuration layers](../GLOSSARY.md). A higher layer overrides a lower one:

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
  `review.repo_label` and `ci.required_checks` describe one repository. Set
  in the user file they would apply to every repository on the machine, so
  the user file refuses them with an error naming the field. An environment
  variable may still override them for one run.
- **Adoption is the repository's file.** A user file alone does not make a
  repository look adopted: `resolve-review-comments` and the tracker scripts
  still refuse to run without `.config/jig.yaml`. The skills that run on
  their defaults read the user file and the environment either way.
- **Paths** in any layer are relative to the repository root, as in the
  repository's file.
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
| Integration branch (the branch pull requests land on) | The clone's `origin/HEAD`, else GitHub's default branch | Pull-request base, round diffs, CI policy | `repository.base_branch`, `DRIVE_PR_BASE_BRANCH` |
| Pull-request template | `pull_request_template.md` (or `.txt`, any letter case) in the root, `.github/` or `docs/`, and the files of a `PULL_REQUEST_TEMPLATE/` folder there | The body an agent fills in | none: edit the template |
| Title convention | A commitlint configuration (`commitlint.config.*`, `.commitlintrc*`, `commitlint` in `package.json`) that names the Conventional Commits rules, such as `@commitlint/config-conventional`; else at least 80% of the last 30 non-merge trunk commit subjects following [Conventional Commits](https://www.conventionalcommits.org/), and at least five such subjects to judge from | Whether titles take `type(scope): summary` | `pull_requests.title_format` |
| Delete head branches on merge | GitHub repository settings | Warning for `branch` stacking: without it GitHub does not retarget the layer above a merged one | none: change the setting |
| Code owners | `.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS` | Reported only: GitHub requests those reviewers itself | none |
| Required checks | The protection and rulesets of the branch the pull request (or its stack) lands on | Which checks certify a converged head | `ci.required_checks` |
| Draft or Ready on opening | `drive.reviews_drafts: false` means Ready | How a pull request opens | `pull_requests.open_as` |

## `gates`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `gates.command` | shell command | **Required by `resolve-review-comments`**, which refuses without it. `drive-pr` then has no local checks unless `drive.validation_plan_command` is set | resolve-review-comments, drive-pr, fix-ci, resolve-conflicts, descar | The repository's complete local checks, run before every push |

## `review`

How review threads are resolved and how the drive recognises its AI reviewer.

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `review.bots` | list of logins | **Required by `resolve-review-comments`**. `drive-pr`: none | resolve-review-comments, drive-pr, review | Reviewer accounts (`coderabbitai[bot]`) whose threads the review skill works. Without `review.reviewer_app`, the drive accepts the reviewer's summary comment only from these logins |
| `review.job_pattern` | regular expression, or `null` | Reviewer checks recognised by name | resolve-review-comments | Which check runs the review skill waits on. Setting it requires `review.required_checks`. `--job-pattern` overrides it |
| `review.required_checks` | list of distinct check names | none | resolve-review-comments | Reviewer checks that must each complete before a round is judged. Required when `review.job_pattern` is set. Unrelated to `ci.required_checks` |
| `review.deferral_team` | team key | **Required by `resolve-review-comments`** | resolve-review-comments | Tracker team that deferred findings are filed into. `--team` overrides it |
| `review.repo_label` | label | Empty, which fails unless `--repo-label` is given | resolve-review-comments | Repository label put on filed follow-ups; must be one of `review.taxonomy.repos` |
| `review.repo_slug` | `owner/name` | Empty, which fails unless `--repo-slug` is given | resolve-review-comments | Repository whose links a deferred finding must point into |
| `review.taxonomy.types` | list of labels | none | resolve-review-comments | Type labels a follow-up may carry. Requires `ownership_prefixes` |
| `review.taxonomy.repos` | list of labels | none | resolve-review-comments | Repository labels a follow-up may carry. Requires `ownership_prefixes` |
| `review.taxonomy.sizes` | list of labels | `[xs, small]` | resolve-review-comments | Size labels a batch of follow-ups may carry |
| `review.taxonomy.categories` | list of names | only `unknown` | resolve-review-comments | Allowed finding categories |
| `review.taxonomy.context_prefixes` | list of prefixes | none | resolve-review-comments | Prefixes of labels carried from the pull request onto its follow-ups. Requires `ownership_prefixes` |
| `review.taxonomy.ownership_prefixes` | list of prefixes | none | resolve-review-comments | Prefixes of ownership labels; two findings share a batch only when these agree. Required when `types`, `repos` or `context_prefixes` is set |
| `review.taxonomy.provenance_label` | label | `pr-followup` | resolve-review-comments, drive-pr (fleet health) | Older name for `issue_tracker.labels.followup`, still read when that is unset; the two may not disagree |
| `review.taxonomy.epic_label` | label | `epic` | resolve-review-comments, drive-pr (fleet health) | Older name for `issue_tracker.labels.epic`, still read when that is unset; the two may not disagree |
| `review.reviewer_app` | GitHub App slug | none: reviewer checks recognised by name from any app, summary comment accepted only from `review.bots` | drive-pr | App whose check runs and `<app>[bot]` summary comment are the AI reviewer's evidence. `DRIVE_PR_REVIEWER_APP` overrides it |
| `review.reviewer_check_pattern` | anchored regular expression | `^ai[ _-]?review(\s*\(.+\))?$` | drive-pr | Name of the posting reviewer's check run. `DRIVE_PR_REVIEWER_CHECK` overrides it |
| `review.sticky_marker` | text | `<!-- ai-code-review -->` | drive-pr | Text identifying the reviewer's summary comment. `DRIVE_PR_STICKY_MARKER` overrides it |
| `review.reviewed_sha_marker` | text | `ai-reviewed-sha` | drive-pr | Marker for the commit the reviewer reviewed, inside that comment. `DRIVE_PR_SHA_MARKER` overrides it |

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
| `severity_mapping` | map from each severity, and `unknown`, to `{linear_priority, acceptance}` | no | The tracker priority and acceptance tier each severity corresponds to; checked when present, not used by the ladder |
| `calibration` | any | no | Notes for people; not read |

The test fixture
[`review-triage.yaml`](skills/resolve-review-comments/__tests__/fixtures/review-triage.yaml)
is a complete example.

## `repository`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `repository.base_branch` | branch name, without `origin/` | Derived: the clone's `origin/HEAD`, else GitHub's default branch | drive-pr, do-item, review, descar | The integration branch: where pull requests land. A round diffs against its pull request's own base, so a stacked layer's round covers that layer alone; it diffs against this branch only on a branch with no pull request, and refuses when the pull request's base cannot be read or fetched, or `origin` is not the pull request's repository. The required checks come from the protection of the pull request's base and, for a stacked layer, of the branch the stack's bottom layer targets; a walk down the stack stops at this branch, and an unknown integration branch is an error. Set it when that is not the default branch (a `develop` flow). `DRIVE_PR_BASE_BRANCH` overrides it |

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
| `pull_requests.branch_name` | pattern | `{key_lower}-{slug}` | Branch name for an issue. Placeholders: `{key}` (`ENG-12`), `{key_lower}` (`eng-12`), `{slug}` (the issue title in lowercase words joined by `-`, at most 40 characters). Must contain `{key}` or `{key_lower}`: the issue key in the branch name is what links the pull request to its issue. Example: `feature/{key_lower}-{slug}` |
| `pull_requests.issue_link` | `closes`, `refs`, `none` | `closes` | The line linking the pull request to its issue: `Closes ENG-12` (merging closes the issue), `Refs ENG-12` (linked, left open), or none |
| `pull_requests.size_budget` | whole number ≥ 1 | no budget | Most changed lines (added plus deleted, against the pull request's base) one pull request may carry. Over it, `pr-plan.ts` refuses: split the change (into a stack when stacking is allowed), or state why it cannot be split with `--accept-oversize <reason>` and put the reason in the body |
| `pull_requests.labels` | list of label names | none | Labels added when the pull request opens, such as `agent-authored`. Each must already exist in the repository |
| `pull_requests.title_format` | `conventional`, `free` | Derived (see [above](#what-is-derived-not-declared)) | Whether titles follow Conventional Commits. With squash merges the title becomes the trunk commit, so it matters |

### Stacking

A *[stacked pull request](../GLOSSARY.md)* is based on another open pull
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
| `drive.validation_plan_command` | shell command | The plan is `gates.command` alone | drive-pr, fix-ci, resolve-conflicts, review, descar | Reads changed files (one per line) on stdin and prints the validation plan as JSON on stdout |
| `drive.load_guard_command` | shell command | No load guard | drive-pr | Waits until the machine can take heavy checks |
| `drive.change_areas_catalog` | path, relative to the root or absolute | No catalog: `--area` unchecked, no area-based agent routing | drive-pr, do-item, review, decide | The repository's [change-area catalog](../GLOSSARY.md) (YAML with an `areas:` map). The plugin reads each area's `paths` and `generated[].source` globs, `labels`, `tracker.labels` and `tracker.flags` (`linear:` is the older spelling of the `tracker:` block) and `agent`, through one reader that refuses an area whose globs, labels or `tracker` block are malformed, with the field at fault; `agent` and the rest of the area are passed through unchecked. `determine_agent.ts --catalog` overrides it for one run |
| `drive.reviews_drafts` | `true`, `false` | Unknown | drive-pr, do-item | Whether the AI reviewer reviews draft pull requests. The drive uses it to explain a draft waiting for a review; `false` also makes new pull requests open Ready unless `pull_requests.open_as` says otherwise |
| `drive.max_rounds` | whole number ≥ 1 | `10` | drive-pr | The default round budget of a drive: how many review rounds it runs before it stops unconverged (exit `6`). The `--max-rounds` flag overrides it for one run. A value that is not a whole number of at least 1 stops the drive, unless the flag names the budget |
| `drive.escape_baseline_doc` | path, relative to the root | `docs/review-loop-baseline.md` | drive-pr | Document recording the human-judged defect-escape baseline that the loop-cost reports compare against |

## `ci`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `ci.required_checks` | list of distinct check names; `[]` means none | Derived from the protection and rulesets of the pull request's base, and of the branch its stack lands on | drive-pr | Checks that must complete on the converged head before the drive certifies it. Required, and not empty, when `ci.hold_label` is set |
| `ci.hold_label` | label | No hold: every push runs full CI | drive-pr | A label the repository's workflows honour by skipping expensive jobs on intermediate pushes; the drive removes it once review converges. See the [drive-pr README](skills/drive-pr/README.md) |

## `issue_tracker`

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `issue_tracker.adapter` | adapter name | `linear` | do-item, drive-pr, decide | Which [tracker adapter](../GLOSSARY.md) answers. `linear` is the only one today; it reads `LINEAR_API_KEY` or `LINEAR_API_TOKEN`, or uses a signed-in `linear` command-line client |
| `issue_tracker.team` | team key such as `ENG` | **Required by the tracker scripts**; elsewhere issue keys are not recognised | do-item, drive-pr, review | The key issue identifiers carry (`ENG` for `ENG-123`) |
| `issue_tracker.states` | map from state key to the tracker's name | Each key title-cased (`in_progress` → `In Progress`) | do-item (status moves, which sub-issue states count as parked, and how a sub-issue state with no category is read) | The tracker's own names for the workflow states. Keys: `triage`, `backlog`, `todo`, `in_progress`, `in_review`, `ops_pending`, `done`, `canceled`, `duplicate`; any other key is an error. Each state needs its own name, except that `triage`, `backlog` and `todo` may share one, and so may `in_review` and `ops_pending` (a tracker with no operations state holds a merged issue in review), and `canceled` and `duplicate` |
| `issue_tracker.labels.epic` | label | `review.taxonomy.epic_label`, else `epic` | do-item, resolve-review-comments, drive-pr (fleet health) | Marks an issue whose sub-issues are worked one at a time |
| `issue_tracker.labels.hitl` | label | `hitl` | do-item, decide | The human-in-the-loop flag; its facets are `<hitl>:<stakeholder>` |
| `issue_tracker.labels.manual_ops` | label | `manual-ops` | do-item | A step a person performs outside the code; caps an epic at `ops_pending` |
| `issue_tracker.labels.followup` | label | `review.taxonomy.provenance_label`, else `pr-followup` | do-item, resolve-review-comments, drive-pr (fleet health) | Marks an issue filed from a review finding |
| `issue_tracker.labels.bug` | list of labels | `[bug, type:bug]` | do-item | Any of these marks a bug |
| `issue_tracker.labels.pattern_prefix` | text | `pattern:` | do-item, reflect, review-reflections | A recurring pattern's label is `<prefix><slug>`; a reflection class's issue is `<prefix><class>` |
| `issue_tracker.labels.batch_sizes` | list of labels | `[xs, small, medium]` | do-item | Sizes whose issues the batch check may group into one pull request |
| `issue_tracker.labels.extractable_tails` | list of labels | `<hitl>:legal`, `<hitl>:tactical`, `<manual_ops>`, `<followup>` | do-item | Open sub-issues an epic may hand off instead of finishing |
| `issue_tracker.file_command` | text | Ask the user to file the issue | do-item, decide, resolve-review-comments, descar, github-actions, promote-memory, reflect, review-reflections | How an agent files a new issue by hand, such as a slash command |

## `do_item`

A section named `do_issue` (the skill's former name) is refused, not ignored:
`do-item` stops and asks for it to be renamed `do_item` (the fields are the
same), rather than running without the repository's routing and gates.

| Field | Type | When absent | Read by | What it does |
|-------|------|-------------|---------|--------------|
| `do_item.agents.default` | agent name | `general-purpose` | do-item | Agent that implements an issue no rule routes |
| `do_item.agents.integrator` | agent name | `do_item.agents.default` | do-item | Agent that coordinates when more than two agents match |
| `do_item.agents.catalog` | map from catalog agent name to agent | none | do-item | Translates the change-area catalog's `agent` values into the repository's agent names |
| `do_item.agents.codearea_areas` | map from issue label to area key | none | do-item | Routes an issue to a change area by label |
| `do_item.agents.labels` | map from issue label to agent | none | do-item | Label routing when the catalog gives no answer |
| `do_item.agents.title_keywords` | map from keyword to agent | none | do-item | Last-resort routing on a case-insensitive title match |
| `do_item.scouts` | map from agent to a list of scouts | none | do-item | Scouts that run before each agent. The key is the **agent**, not a label |
| `do_item.gates` | list of `{labels, paths, skill}` | none | do-item | Review skills that must approve a change before it is pushed, when the issue carries one of the `labels` or the change touches one of the `paths` |
| `do_item.execution_plan_block` | name | `execution-plan-v1` | do-item | Name of the fenced block in an epic's description that holds its machine-readable execution plan |

The routing order and the gates are explained in
[do-item's SKILL.md](skills/do-item/SKILL.md).

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
| `ledger.label` | label, or `null` | no; default `labels.followup` | Label of the debt ledger `fractal-metrics.ts` reports |
| `ledger.project` | tracker project, or `null` | no | A project whose issues also belong to the ledger |
| `ledger.closed_state_types` | non-empty list of state types | no; default `[completed, canceled, duplicate]` | Tracker state types that close a ledger issue |
| `baselines.<metric>.value` | number | per baseline | A recorded baseline for one scoreboard metric |
| `baselines.<metric>.source` | `{file, needle}` | no | The document recording that number and a substring that must still appear in it, so a stale baseline is caught |

The team key comes from `issue_tracker.team` and the change-area catalog from
`drive.change_areas_catalog`. The signal lifecycle and what a diagnosis
comment looks like are described in the header of
`skills/drive-pr/scripts/fleet-health.ts`.

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
| `reflection.store` | `filesystem`, `notion`, `command` | `filesystem` | reflect, review-reflections | Which store answers: the [filesystem store](skills/reflect/README.md#filesystem-store), the [Notion store](skills/reflect/README.md#notion-store), or `reflection.command` |
| `reflection.path` | folder; `~` is the home directory, a relative path is the repository's | `~/.jig/reflections` (under `JIG_HOME`) | reflect, review-reflections | The filesystem store's folder |
| `reflection.command` | a command line, or a list of words | **Required** with `store: command` | reflect, review-reflections | The store command; the operation is appended to it. No shell runs it |
| `reflection.notion.database` | a Notion database id, or a link to it | **Required** with `store: notion` | reflect, review-reflections | The database `notion-store.ts init` created. The integration's secret is read from the `NOTION_TOKEN` environment variable, never from a file |
| `reflection.journal` | file path | `<git-dir>/jig/reflection-journal.jsonl` | reflect, resolve-review-comments | The worktree's journal; a path git would track, or a file it already tracks, is refused. Parking still uses it when the section says `enabled: false` |
| `reflection.escalate_after` | whole number, at least 1 | `3` | reflect, review-reflections | The recurrence count at which a class is escalated to one tracker issue |
| `reflection.timeout_sec` | whole number of seconds, at most 86400 | `120` | reflect, review-reflections | The deadline for one store operation; `list` and `diagnose` get five times as long |
| `reflection.mode` | `quick`, `comprehensive` | `quick` | reflect | The reflection's default depth: what went wrong only, or also what worked and what could improve |

Escalation reads `issue_tracker.labels.pattern_prefix` (a class's issue is
labelled `<prefix><class>` and carries an owner marker, a
`Jig owner: <owner>` line with the owner percent-encoded, in its
description, which the lookup requires) and `issue_tracker.file_command`.

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
| `resolve_conflicts.generated` | list of `{paths: [globs relative to the root], command: shell command}`; globs match as the change-area catalog's do (`**`, `*`, `?`, `{a,b}`, `[...]`) | none: only the built-in lockfile table applies | resolve-conflicts | Files that are regenerated, never hand-merged, when they conflict, and the command that rebuilds them (run from the root). An entry also overrides the built-in lockfile command for a path it matches. Unknown keys are refused |
| `github_actions.conventions_doc` | path, relative to the root | Searched for in the instructions and docs; else generic guidance | github-actions | The document describing the repository's workflows and their conventions |
| `design_brief.kit` | folder, relative to the root | Detected: a tracked folder ending in `design-kit` or `design_kit` | design-brief-builder | The design kit: voice, colours and type, rubric, component previews, logo |
| `design_brief.design_language` | path, relative to the root | Detected: the first tracked `*design-language*.md` or `*design-system*.md` | design-brief-builder | The written design canon |
| `design_brief.prototypes` | folder, relative to the root | none: the agent asks | design-brief-builder | Where finished design bundles land, one folder per flow |
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
| `JIG__<SECTION>__<FIELD>` | Sets one field for this run, over every file (see [configuration layers](#configuration-layers)) |
| `LINEAR_API_KEY`, `LINEAR_API_TOKEN` | Credentials for the Linear adapter |
| `DRIVE_PR_BASE_BRANCH`, `DRIVE_PR_REVIEWER_APP`, `DRIVE_PR_REVIEWER_CHECK`, `DRIVE_PR_STICKY_MARKER`, `DRIVE_PR_SHA_MARKER` | Override the matching field for one run |
| `DRIVE_PR_STATE_DIR` | Where a drive keeps its rounds, locks and leases |
| `JIG_VERIFICATION_FIT_LOG` | Where verification-fit verdicts are logged |
| `DEV_DASHBOARD_DIR` | Overrides `fleet_health.snapshot_dir` |
| `JIG_REVIEW_TRIAGE_CONFIG` | The [review-triage file](#the-review-triage-file) to read instead of `.config/review-triage.yaml` |
| `JIG_GH_CACHE_DIR` | Where cached GitHub answers are kept; default `~/.cache/jig/gh-cache` |
| `JIG_GH_CACHE` | `off` disables that cache |
| `GH_CALL_TIMEOUT` | Seconds one `gh` call may take; default 30 |
| `JIG_LOG` | How much the scripts' diagnostics say on standard error: `error`, `warn` (the default), `info` or `debug`. At `debug` a failing script also prints the stack of the failure and its causes, with the last 4,096 bytes of a failed command's error output where the failure carries it (`resolve-review-comments`' `gh` calls), and an error dropped on purpose is printed with the reason |
| `JIG_LOG_FORMAT` | `text` (the default) writes `<script>: <message>`; `json` writes one JSON object per line with the time, level, script, message and fields |
| `AWAIT_ROUND_CHECKS_MAX_AGE` | Seconds a still-waiting read of a pull request's checks may be reused while nothing on GitHub changed; default 300, `0` always reads |
| `JIG_REFOCUS` | `1` or `0` puts `do-item`'s intent-chain snapshot in the Refocus calibration's on or off arm; unset, odd issue numbers are on |
| `BASH_MAX_TIMEOUT_MS` | Claude Code's own variable, not Jig's: the longest `timeout` an agent may give a background command in an unattended session, 2 hours unless raised. Set it to `28800000` so a drive can outlast 2 hours (see [the background time limit](skills/drive-pr/README.md#the-background-time-limit)) |
| `DRIVE_PR_*` (others) | Round limits, timeouts and repair budgets; listed in the [drive-pr README](skills/drive-pr/README.md) |
| Others | A few knobs of a single skill, such as `REFLECT_THRESHOLD` of `resolve-review-comments`, are described where that skill's `SKILL.md` uses them |

## Complete example

Every section, with values a typical repository might set. Copy only what
differs from the defaults.

```yaml
gates:
  command: bun run gates                 # required by resolve-review-comments
review:
  bots: ["coderabbitai[bot]", "example-review[bot]"]   # required by resolve-review-comments
  deferral_team: ENG                     # required by resolve-review-comments
  repo_label: web
  repo_slug: example/web
  job_pattern: "^AI review"
  required_checks: ["AI review"]
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
repository:
  base_branch: develop                   # default: the repository's default branch
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
  adapter: linear
  team: ENG                              # required by the tracker scripts
  file_command: "linear issue create"
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
fleet_health:
  config: .config/fleet-health.yaml
  snapshot_dir: ~/.local/state/jig/dashboard
adr:
  directory: docs/adr
  rules_file: docs/adr/rules.yaml
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
github_actions:
  conventions_doc: docs/ci.md
design_brief:
  kit: docs/design-kit
  design_language: docs/design.md
  prototypes: design/prototypes
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
  journal: .scratch/reflection-journal.jsonl
  escalate_after: 3
  timeout_sec: 120
  mode: quick
```
