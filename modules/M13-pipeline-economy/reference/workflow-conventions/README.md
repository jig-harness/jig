# Workflow-convention lint

Part of [M13 Pipeline economy](../../README.md).

**What problem this solves.** The conventions that keep
[CI](../../../../GLOSSARY.md) cheap and honest live in the workflow files: a
timeout on every job, a concurrency group that cancels a superseded push, an
[aggregator job](../../../../GLOSSARY.md) that runs whenever its run was not
cancelled, an action pinned to a commit. Written down only as prose, they
regress one edit at a time: a new job arrives without a timeout, someone
"fixes" a flaky aggregator with `always()`, a slow suite gains a
`pull_request` trigger, a path filter lands on the workflow behind the
required check. Nothing fails on the day it happens; the cost shows up weeks
later as a runner held for six hours or a check that never reports.

`check-workflow-conventions.ts` reads the parsed workflows and composite
actions and fails a change that breaks one of the conventions below. It
checks only; it changes nothing.

## Invariant

> Pipeline-efficiency conventions are checked by a gate over the parsed
> pipeline definitions. The gate fails closed on input it cannot parse, every
> exception carries a reason, and an exception that no longer suppresses
> anything is an error.

## Usage

```bash
bun check-workflow-conventions.ts [--root <dir>] [--workflows <dir>] \
  [--actions <dir>] [--jig-config <file>] [--config <file>] [--exceptions <file>]
```

Every path defaults to its place under `--root` (default `.`):

| Option | Default | What it is |
|--------|---------|------------|
| `--workflows` | `.github/workflows` | the workflows (`*.yml`, `*.yaml`) |
| `--actions` | `.github/actions` | actions, `action.yml` or `action.yaml` at any depth |
| `--jig-config` | `.config/jig.yaml` | the repository's own values: `ci.required_checks`, `ci.hold_label`, `drive.change_areas_catalog` ([CONFIGURATION.md](../../../../plugin/CONFIGURATION.md)) |
| `--config` | `.config/workflow-conventions.yaml` | the lint's configuration: heavy suites and cache groups |
| `--exceptions` | `.config/workflow-conventions-exceptions.txt` | the reasoned exception list |

A default file or folder that does not exist reads as empty, so a repository
adopts the lint before it writes any configuration. A file or folder named on
the command line must exist.

The script imports helpers from the Jig repository's `lib/` (the shared
workflow reader `workflows.ts` with its vendored YAML parser, `findings.ts`,
`cli.ts`) and the plugin's change-area catalog reader, so run it from a
pinned Jig checkout rather than copying it.

## Rules

Each finding names its rule, the file and line, the problem and the fix.

### job-timeout

Every job has `timeout-minutes`, a positive number of minutes within a
60-minute ceiling, or an expression. A hung job otherwise holds its runner
until the provider's 360-minute default. Size the value to about two to three
times the job's slowest healthy run: the timeout stops a hang, and a tighter
one fails healthy runs on a busy runner. A job that needs more than the
ceiling is sharded, or carries a reasoned exception. A job that calls a reusable workflow (`uses:` at job level) cannot
carry the key: the called workflow's jobs carry their own, and the lint checks
them where the called workflow is in the same repository.

### pr-concurrency

A workflow triggered by `pull_request` or `pull_request_target` has a
concurrency group with `cancel-in-progress: true` (or an expression), at
workflow level or on every job, so a new push cancels the runs for the older
head. A group without it queues every push instead.

### required-not-path-filtered

A workflow that reports a required check has no `paths` or `paths-ignore` on
any trigger. A run filtered out never starts, so its required check waits
forever; select jobs inside the run instead.

The required checks come from `ci.required_checks` when the repository sets
it: a job reports the check named by its literal `name:`, or its id. When it
is unset, the lint derives them: in a workflow triggered by `pull_request`,
`pull_request_target` or `merge_group`, an aggregator is a job that needs
every other job of its workflow, whatever its `if:` says, so an aggregator
with no condition at all is found too. A job the configuration names heavy
(`<file>#<job>`) is never one. Workflows with no such trigger (a release on
tags, a deploy on push) hold no derived aggregator. A pass prints which
jobs it took as required and how.

### aggregator-unless-cancelled

A required job that needs other jobs runs on exactly `!cancelled()`
(optionally inside `${{ }}`) and not on `always()`. Without a condition, a
failed job it needs makes it skip, and a skipped check counts as passing;
with `always()` it also runs, and fails, on a run a newer push cancelled.
Anything joined to `!cancelled()` counts as a different condition:
`&& success()` skips the job after a failure it should report, and
`== false` inverts it. A condition the lint does not read as `!cancelled()`
is a finding to rewrite or excuse, never a pass.

### ci-hold

Applies only when `ci.hold_label` is set ([the CI hold](../../../../plugin/skills/drive-pr/README.md#ci-hold));
otherwise a pass says it was not applicable.

- `ci-hold-guard`: every heavy job (see below) of a pull-request workflow
  skips while the label is present, and so does every job of a pull-request
  workflow that calls a heavy workflow of the repository, directly or
  through another one. A required job inside a whole heavy workflow is
  exempt, since it must report, but only when `ci.required_checks` names it:
  a derived aggregator may be the heavy work itself, so with the field unset
  every job of a whole heavy workflow carries the guard. A job named heavy by
  itself is never exempt. One of the
  `if:`'s `&&`-joined terms is exactly `!contains(<labels>, '<label>')` or
  `!(contains(<labels>, '<label>'))`, with `<labels>` the pull request's
  `github.event.pull_request.labels.*.name` and the exact label quoted. A
  condition with `||` anywhere outside a string does not count, since it can
  run the job while held; nor does a term that only holds the test
  (`!!contains(…)`, `!contains(…) == false`), the test inside a quoted
  string, another first argument, or a label that only contains the
  configured one (`on-hold` for `hold`).
- `ci-hold-sentinel`: some job of a pull-request workflow that holds a
  required check fails while the label is present, and its failure reaches
  that check. The job is the required job, or one the required job needs
  directly while itself running on exactly `!cancelled()`; a job reached only
  through another is not taken, since the job between can succeed whatever
  the sentinel returned, and a required job on any other condition is
  skipped by a failed need, which counts as passing. Either the job runs
  while held (no `if:` and no `needs`, or a whole `if:` of exactly
  `!cancelled()`) and has a `run:` step whose whole `if:` is
  `contains(<labels>, '<label>')`, optionally inside `${{ }}`; or the job's
  own whole `if:` is that test, it needs no job, and it has a `run:` step
  with no `if:`. Any other job condition, `false` included, may skip the job,
  and a skipped sentinel fails nothing. Neither the job nor that step may set `continue-on-error`,
  since a tolerated failure fails nothing. That step is where the held head
  fails, so it is visibly not mergeable. Any other spelling, negated,
  compared with `false` or combined with another condition, is not taken as
  the sentinel: a sentinel the lint misses is a finding to rewrite, a
  misread one would be a false pass. Its finding points at the configuration
  that sets the label.

### heavy-per-change

A heavy suite has no per-change trigger: `pull_request`,
`pull_request_target`, `merge_group`, or a `push` that is not restricted to
named branches or tags (a branch pattern with `*` counts as every branch;
a push filtered only by `tags` or `tags-ignore` never runs for a branch).
A push to the integration branch, a schedule and a manual dispatch are
fine. A workflow called by another workflow of the repository
(`uses: ./.github/workflows/<file>`) also runs on its callers' triggers, so
a heavy one called from a pull-request workflow runs per change too
(reported as `pull_request via <caller>`).

Which suites are heavy cannot be read from a workflow, so the lint's
configuration declares them, a whole workflow or one job:

```yaml
heavy:
  - nightly.yml        # every job of the workflow
  - ci.yml#e2e         # one job
```

A heavy suite that the merge does wait for, and so runs per change on
purpose, carries its marker in the exception list, with the reason:

```text
# A required check: the merge waits for the end-to-end suite, and the CI
# hold runs it once per review rather than on every push.
heavy-per-change .github/workflows/ci.yml e2e
```

The marker lives there rather than in the workflow so that it carries a
reason the lint checks, and goes stale, and fails, once the suite no longer
runs per change. An entry naming no workflow or job is a finding against the
configuration.

### cache-env-parity

Pipelines that share a cache have the same key-affecting environment;
otherwise one writes entries the other reads under different conditions.
Groups are declared, since which jobs share a cache cannot be read reliably;
with none, the rule is not applicable:

```yaml
cache_groups:
  - name: build-cache
    members: [ci.yml#build, nightly.yml#build]   # at least two
    env: [NODE_ENV, TARGET]   # optional: only these keys; default: all
```

A job's environment is its workflow's `env:` overlaid with its own. A member
differing from the first one is reported on its own job.

### pinned-uses

Every `uses:` in a workflow step, a reusable-workflow call and a composite
action's steps names a full 40-character commit SHA; a `docker://` image,
there or as a Docker action's `runs.image`, names a `@sha256:` digest; a local `./` action or workflow is exempt. A tag
or branch can move after review. Why, and the update path that keeps pins
fresh, is [M1's piece 7](../../../M1-gates-enforcement-ladder/README.md#core-pieces)
(third-party automation integrity).

### push-pr-paths

When a workflow has a push trigger and a pull-request trigger and either is
filtered by paths, both carry the same filters (`paths` with `paths`,
`paths-ignore` with `paths-ignore`); with both `pull_request` and
`pull_request_target`, push is compared with each. Otherwise a change merges
checked by one selection and runs on the branch under another; a filter on
only one of the two is the same mistake. Order is ignored unless a list holds
a negative pattern (`!docs/private/**`): a later pattern overrides an earlier
one, so then the lists must match in order too. A push filtered only by `tags` or
`tags-ignore` runs for tags, not for the branch, and is not compared.

### catalog-paths

When the repository has a [change-area catalog](../../../M3-change-area-catalog/README.md)
(`drive.change_areas_catalog`), every trigger's `paths` list is exactly the
globs of whole catalog areas: the union of one or more areas' `paths` and
`generated[].source` globs. The tie is read, not declared: the areas whose
globs are all listed are the workflow's areas, and a listed glob outside
them fails, naming any area it lists only in part. A filter copied by hand
drifts from the catalog the resolver reads; `paths-ignore` is not compared.

## Exceptions

One entry per line, `<rule> <file> [<job>]`, the file as findings name it
(relative to the root). An entry covers every finding of its rule in its
file, or in its job when it names one; a repeated entry covers nothing, so
it is stale. Each group of entries opens with `#` lines that give its
reason, and a blank line ends the group. An entry without a reason is a
finding (`exception-list`) and suppresses nothing; an entry that suppresses
no finding is a finding too, so the list prunes itself when the code it
excused is gone. A rule name the lint does not know, or a line of another
shape, makes the list malformed (exit 2).

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Every convention holds | what it read and which rules had nothing configured, then `OK — …` |
| 1 | At least one finding | each finding on standard error (`file:line: [rule] problem`, then `fix: …`); under GitHub Actions also as an `::error` annotation |
| 2 | Could not check | the reason on standard error |

It fails closed: a folder that cannot be read, a file that is not valid YAML
(a repeated key included, which a parser keeping the last copy would let hide
a job), a workflow without a `jobs:` map or with no job in it, an `on:`
whose events are not names or whose event settings are not a map (a list of
cron entries for `schedule`), a path, branch or tag filter that is not a
list of patterns, a job whose `steps` is not a list of steps, whose `needs`
is not a job id or a list of them, or whose `env` (or the workflow's) is not
a map, an action without a `runs:` map naming `using` and its entry point
(`steps`, `image` or `main`), a `ci.required_checks` holding a blank or
repeated name (an empty list is a deliberate choice and reads as none), a
malformed configuration, catalog or exception list, a folder named on the
command line that does not exist, and finding no workflow and no action at
all each exit 2. Input it could not read never passes.

It reads the shape its rules depend on, not every value GitHub accepts:
whether a cron expression is valid or a Node runtime is still supported is
decided by GitHub when it loads the workflow or action, and is a dedicated
workflow linter's check (actionlint, for one). A copy of GitHub's grammar and
runtime list here would drift from GitHub's own, so the lint requires that a
schedule names cron entries and that an action names a known kind of
runtime, and stops there.

## How to adopt

1. Run it once with no configuration: `--root` at the repository. Fix what it
   reports, or add a reasoned exception where a rule does not fit.
2. Declare the heavy suites and cache groups, if any, in the configuration.
3. Run it in CI on every change that touches the workflow files, beside the
   other gates ([M1](../../../M1-gates-enforcement-ladder/README.md)).

Jig runs it on its own workflows in `bun run gates`
(`scripts/check-workflow-conventions.ts`), where finding no workflow could
not check even when an action is present, since Jig always has workflows.

## Known limits

It reads the parsed files; it does not evaluate expressions or follow a
remote reusable workflow. A required check whose name is an expression (a
matrix job's `name:`) is matched by its id only. With `ci.required_checks`
unset, the aggregator is derived only in workflows that gate a merge, and a
required check reported by another workflow shape is not seen: set the field
to name it. A `timeout-minutes` written
as an expression is accepted unchecked, since its value is known only at run
time. The lint finds the sentinel step by its condition but cannot prove the
step fails: its script must exit non-zero, which review checks. Whether a concurrency key
covers what it cancels, and whether an aggregator's script judges each result
correctly, stay with review.

## Files

| File | Role |
|------|------|
| `check-workflow-conventions.ts` | the gate: options, exceptions, report |
| `inputs.ts` | reads the workflows, actions, configuration and exception list, failing closed |
| `rules.ts` | the rules, one function each |
| `check-workflow-conventions.test.ts` | paired self-test |
| `fixtures/` | one small repository per case: a pass and a fail per rule, composite actions, unparseable input, a repeated key, stale, reasonless and unknown-rule exceptions, malformed configuration |
