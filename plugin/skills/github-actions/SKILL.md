---
name: github-actions
description: "Review GitHub Actions workflow changes for security, correctness, performance and fit with the repository's CI architecture; use it when a change touches .github/workflows or .github/actions."
context: fork
---

# GitHub Actions workflow reviewer

## Overview

This skill reviews changes to GitHub Actions workflows (the YAML files under
`.github/workflows/` and the composite actions under `.github/actions/`) for
security, correctness, performance, and fit with the repository's own CI
([continuous integration](https://github.com/docomply/jig/blob/main/GLOSSARY.md)) architecture.
The pipeline it checks against is the one Jig module
[M10 (environments & deploy)](https://github.com/docomply/jig/blob/main/modules/M10-environments-deploy/README.md)
describes: gates on every pull request, verification after merge, deploys of
verified builds only, and a manual promotion to production.

**Scope:** review and audit of workflow files.
**Output:** a structured assessment with findings, security notes and
recommendations (see [Output format](#output-format)).

---

## The repository's CI architecture

Read the repository's own description of its pipeline first, if it has one.
It is the reference for scope, triggers and job order in every phase below,
and the only reference for Phase 4.

1. Read `github_actions.conventions_doc` from the repository's Jig
   configuration with
   `bun "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/jig-config.ts" github_actions.conventions_doc`
   (every layer, `.config/jig.yaml` among them; exit 2 means no layer sets
   it): the path of the document that describes the repository's workflows
   and their conventions.
2. When the field or the file is absent, look for such a document: search the
   instruction file (`AGENTS.md` or equivalent) and the docs tree for one that
   describes the CI pipeline or workflow strategy.
3. When there is none, review against the generic guidance in this skill only,
   skip Phase 4's drift comparison, and say so in the report.

[Jig's M10 template](https://github.com/docomply/jig/blob/main/modules/M10-environments-deploy/templates/CI-ARCHITECTURE.md)
is one common shape for such a document. It splits delivery into four stages,
each with one responsibility and a hard boundary to the next:

```
1. PR gates
   Trigger: every pull request
   Scope:   everything the diff affects
   Purpose: block the merge until the quality gates pass

2. Post-merge verification
   Trigger: push to the default branch
   Scope:   what is deployed, plus the shared libraries it uses
   Purpose: verify the integrated branch; advance the verified pointer

3. Deploy
   Trigger: the verified pointer moves
   Scope:   deployable applications
   Purpose: deploy, by digest, the build of the commit the pointer names,
            never a moving branch; done when the live environment reports it

4. Promotion to production
   Trigger: a human, manually, from the trusted ref
   Scope:   deployable applications
   Purpose: put the verified, deployed build in front of users: one promotion
            at a time, the gated commit passed from job to job, and the live
            identity checked at the end
```

When the repository's document sorts its packages by role, check every
workflow's scope against that sorting. A typical split:

| Role | PR gates | Post-merge verification | Deploy |
|------|----------|-------------------------|--------|
| Deployed applications ([deploy-critical](https://github.com/docomply/jig/blob/main/GLOSSARY.md)) | Yes | Yes | Yes |
| Tools that are never deployed (command-line tools, simulators, viewers) | Yes | No | No |
| Shared libraries | Yes | Yes | Not applicable |

A package whose types or code are generated is still type-checked and tested
unless the document says otherwise; a filter that excludes a package which no
longer exists matches nothing and should be removed.

---

## Review checklist

### Phase 1: Security

**1.0 Action pinning (check this first)**

Every repository action in `uses:` (`owner/repo@ref`) must name a full
40-character commit SHA, followed by a `# vN` comment. A tag (`@v6`, `@1.2.3`) or a branch (`@main`) can be moved
by the action's owner after review, so the workflow would run code nobody
reviewed. This is the immutable-pin invariant of
[M1 (gates and enforcement ladder)](https://github.com/docomply/jig/blob/main/modules/M1-gates-enforcement-ladder/README.md),
paired there with an automated updater that proposes pin bumps. When the
repository enforces pins with a check, a mutable reference is a hard CI
failure; either way, report it.

```yaml
# GOOD: commit SHA plus version comment
- uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
- uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
- uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7

# BAD: mutable reference
- uses: actions/checkout@v6
```

A Docker image action (`uses: docker://image:tag`) has no commit to pin.
Pin it by image digest instead, `docker://image@sha256:<digest> # tag`; a bare
tag can be repointed the same way a git tag can.

Local composite actions (`./.github/actions/...`) are exempt. To bump a
version, resolve the new tag to its SHA and update the `# vN` comment in the
same edit.

**1.1 Permission scoping**

Check that the `permissions:` block grants the least privilege the job needs.
Never `write-all`.

Common permissions:

- `contents: read`: check out code
- `contents: write`: push commits, advance branches
- `packages: write`: push to GitHub's container registry
- `pull-requests: write`: comment on pull requests
- `actions: read`: download artifacts from other runs
- `id-token: write`: exchange GitHub's identity token for short-lived cloud
  credentials (identity federation), instead of storing a cloud key as a
  secret

**1.2 Secret exposure**

Check for:

- secrets logged to the console (`echo`, debug output);
- secrets passed as command-line arguments;
- secrets in uploaded artifacts;
- secrets used without checking that they are set.

Example: [secret check](references/workflow-examples.md#secret-check).

**1.3 Token usage**

- A push made with `GITHUB_TOKEN` does not trigger other workflows (GitHub's
  guard against recursive runs).
- Where a downstream workflow must trigger (for example, advancing a verified
  branch that starts the deploy), the push needs a personal access token or a
  GitHub App token. Check that it has the minimal scopes.
- A bot that writes a machine-advanced ref (the
  [verified pointer](https://github.com/docomply/jig/blob/main/GLOSSARY.md),
  a rendered-state ref:
  [M10](https://github.com/docomply/jig/blob/main/modules/M10-environments-deploy/README.md))
  has an identity of its own, scoped to that ref: a GitHub App whose
  installation token is minted in the one job that advances the ref, with
  contents read and write (and workflows, where the ref carries workflow
  files) and nothing more, and the only identity the ref's protection lets
  push. Check that no other job references the App's credentials and that no
  broader token (a personal access token, a bot shared with other jobs)
  writes the ref: an identity that can push any ref makes a release path of
  every job that holds it.

**1.4 Expression injection**

Never put a workflow expression inside `run:`. GitHub substitutes the
expression into the script text before the shell reads it, so a value an outsider can set (a
branch name, a pull-request title or body, a commit message, an issue
comment, a dispatch input) runs as shell: an
[expression injection](https://github.com/docomply/jig/blob/main/GLOSSARY.md).
Pass the value through `env:` and read the variable in the script, where the
shell treats it as data (example:
[expression through env](references/workflow-examples.md#expression-through-env)).
The same holds for the `script:` of a JavaScript action step and for a
composite action's `run:`. Where the repository runs a static workflow
auditor, it reports this class; point the author at it
([Checks the repository may already enforce](#checks-the-repository-may-already-enforce)).

---

### Phase 2: Correctness

**2.1 Job timeouts**

Every job needs an explicit `timeout-minutes`. Starting points:

- Code quality (format, lint, types): 10 minutes
- Tests without coverage: 10 minutes
- Tests with coverage: 20 minutes
- Build check: 15 minutes
- Container build: 15 minutes
- Artifact packaging: 10 minutes

`timeout-minutes` counts run time only: a job waiting for a runner is not
timed, so a [queue stall](https://github.com/docomply/jig/blob/main/GLOSSARY.md)
shows as a run that never starts, never as a timeout. A longer timeout does
nothing for it; the bound on waiting is M13's scheduled queue watchdog, where
the repository runs one.

**2.2 Conditional execution**

When a workflow detects which parts changed, every downstream job needs an
`if:` condition on that result (example: [conditional jobs](references/workflow-examples.md#conditional-jobs)).

**2.3 Task-runner scope and concurrency**

In a [monorepo](https://github.com/docomply/jig/blob/main/GLOSSARY.md) driven by a task runner (Turborepo, Nx
and similar), check that each workflow's package filters match its stage in
the repository's architecture: PR gates cover everything the diff affects;
post-merge verification leaves out packages that are never deployed. For
example, with Turborepo:

```yaml
# PR gates: all packages (the runner scopes to what changed)
pnpm turbo run test --concurrency=4

# Post-merge verification: leave out tools that are never deployed
pnpm turbo run test --concurrency=4 --filter='!@shop/cli' --filter='!@shop/load-simulator'
```

Set an explicit concurrency on every multi-package test run. Each test
framework starts its own pool of workers per package, so an unbounded task
runner multiplies the two and oversubscribes the runner's processor cores.
Where the repository's own scripts (`package.json` `scripts`) already set the
limit, a workflow that calls the task runner directly must set it itself.

**2.4 Artifact handling**

Name artifacts after the commit SHA, so each can be traced to its source, and
set `if-no-files-found: error` so an empty upload fails (example:
[artifact naming](references/workflow-examples.md#artifact-naming)).

**2.5 Concurrency keys**

Apply M13's superseding rules (piece 3): two runs share a
[concurrency group](https://github.com/docomply/jig/blob/main/GLOSSARY.md)
only when the survivor covers everything the displaced run would have
checked. For each workflow the change touches:

- **Pull-request runs** group on the pull request number or ref with
  `cancel-in-progress: true`, so a new push cancels the runs of the older
  head; a group without it queues every push. The workflow-convention lint
  checks this where the repository runs it.
- **The key covers every input that changes what the run does**: the ref or
  commit, `github.event_name` wherever a dispatch, a push and a schedule
  could land on the same ref, and the dispatch inputs, through
  `github.run_id`. GitHub keeps one pending run per group and cancels the
  older one silently, also with `cancel-in-progress: false`, so a key that
  two non-interchangeable runs share drops one of them and nothing reports
  an error. Audit: list the workflow's `workflow_dispatch` inputs; a group
  that stays the same when an input changes is a finding, and so is a group
  with no ref or commit term.
- **A dispatch is keyed by its run id, never by an interpolated input.**
  Group names compare case-insensitively while refs, tags and environment
  names do not, and the expression language has no hash to encode around
  it, so two dispatches naming `Release` and `release` would share one group
  and cancel each other. Two deliberate manual runs both running is the
  harmless outcome; one dropped is not.
- **A schedule and a manual run on the same ref** are separated by the
  event name in the key, so a manual backfill never cancels the scheduled
  run; a dispatch that operates on another ref takes it as an input and is
  keyed by its run id as above.
- **Serialized post-merge verification** uses a fixed group with
  `cancel-in-progress: false`, sound only because the surviving run checks
  the whole range from the
  [verified pointer](https://github.com/docomply/jig/blob/main/GLOSSARY.md)
  to its head; a run that cannot cover that range (a dispatch from another
  branch) falls back to its run id, so it cannot displace one that does.
- **A push scan that covers a commit range keeps a per-commit group**:
  each run answers for its own range, and a cancelled run's range is never
  scanned.

Example: [concurrency keys](references/workflow-examples.md#concurrency-keys).
The lint checks that a pull-request group cancels; what each key must
cover is the reviewer's to decide.

**2.6 Which workflow file runs**

- A `workflow_dispatch` run executes the workflow file of the ref it is
  dispatched from, and checks that ref out by default. Dispatched from a
  branch that lags the integration branch, it runs an old copy: gates added
  since are skipped and nothing says so. Check that the runbook and any
  script that dispatches the workflow name the branch whose file is current,
  and that a run which operates on another ref takes it as an input and
  checks it out explicitly rather than being dispatched from it.
- A `workflow_run`-triggered workflow executes the default branch's file,
  with `github.ref` set to the default branch, whatever branch the
  triggering run was on. A condition on `github.ref` there checks nothing
  about the triggering run; its identity is in `github.event.workflow_run`
  (`head_branch`, `head_sha`, `event`, `conclusion`, `head_repository`), and
  a change to such a workflow takes effect only once it is on the default
  branch, so no pull request can exercise it.

---

### Phase 3: Performance

These checks apply Jig module
[M13 (pipeline economy)](https://github.com/docomply/jig/blob/main/modules/M13-pipeline-economy/README.md):
spend CI only where it changes a merge decision, and never let a saving turn
a failure into a pass.

**3.1 Cache configuration**

Check that the package manager's dependency cache is configured, and the task
runner's remote cache where the repository uses one. Keep the package manager
version in the workflow in step with the repository's own pin (for example
the `packageManager` field of `package.json`). Example:
[caching](references/workflow-examples.md#caching).

Then the four cache rules of M13's piece 8, on every cache the change
touches:

- **Complete key.** The key covers every input that changes the output,
  environment values included: `hashFiles()` over every lockfile with the
  runner's operating system and the toolchain version for a dependency
  cache; the task runner's declared environment list for its cache. A
  `--force`, `--skip-cache` or equivalent that stays in the workflow is a
  finding: a stale result is fixed by completing the key.
- **One namespace.** Every job that shares a cache has the same
  key-affecting `env:` (a lint with cache groups, where the repository runs
  one, compares them). A job that uses a remote cache checks its credentials
  are non-empty before the first task: GitHub substitutes an empty string
  for a secret that is absent or rotated out, and an empty value splits the
  job off the shared cache with no error (it runs without it, or, where the
  value selects the store, in a cache namespace of its own). The `secrets`
  context is unavailable in `if:`, so the check reads the value from `env:`
  (a composite action takes it as an input).
- **Bounded and measured.** The cache's key scheme and retention bound are
  written in the repository's pipeline-economy page; a persistent runner
  volume keeps exact keys only, so its key follows the written convention.
  The run writes its hit rate (hits and misses) to `$GITHUB_STEP_SUMMARY`.
  A `cache-to: type=gha` on a build whose builder is the default `docker`
  driver, without the containerd image store, exports nothing (declared,
  inert); it needs the `docker-container` driver or that image store. A container build whose store is on a cache mount carries the
  mount on every `RUN` that invokes the package manager, which M13's
  cache-mount check enforces where the repository runs it.
- **Trust boundary.** A `pull_request` run from a fork has no secrets, so it
  runs without the remote cache: never `pull_request_target` to give it
  credentials. The task runner's remote cache is signed, and a cache written
  on a pull-request branch stays readable from that branch alone.

**3.2 Parallelization**

Independent jobs should run in parallel. Use `needs:` only where one job
really depends on another's result.

**3.3 Redundant operations**

- Coverage: a scheduled trend, collected in one place and published also
  when it is below target
  ([M14](https://github.com/docomply/jig/blob/main/modules/M14-testing-strategy/README.md)
  piece 10; M13's placement table), never again in post-merge verification.
  A per-file blocking threshold is a finding in itself (M14 says why), and
  only a threshold that gates the merge belongs in the PR gates; the trend
  job measures, it does not gate.
- Build: do not build the same thing twice in one workflow.
- Checkout: use `fetch-depth: 0` only when the job needs the git history.

---

### Phase 4: Documentation alignment

**4.1 Comment accuracy**

Check that each workflow's header comment matches what it does: purpose,
scope and trigger.

**4.2 Architecture drift**

Compare the change with the repository's CI architecture document (found
above):

- triggers match the documented flow;
- package scope matches the documented roles;
- job dependencies match the documented order;
- outputs match what the document says the next stage expects.

---

## Output format

Produce a structured Markdown report with these sections: **Overall
assessment** (status and risk level), **Security findings**, **Correctness
findings**, **Performance findings**, **Documentation drift**, **Recommended
actions** (in priority order), and a **Checklist summary** covering action
pinning, permissions, secret exposure, tokens, expression injection,
timeouts, conditional execution, task-runner scope, artifact naming,
concurrency keys, the file a dispatch or `workflow_run` executes, caching
(key, namespace, bound and hit rate, trust boundary), parallelization,
coverage placement and documentation alignment.

---

## Related skills

| Need | Use |
|------|-----|
| Fix a red CI run on a branch or pull request | `/jig:fix-ci` |
| File an issue for a workflow bug | the repository's issue-filing command (`issue_tracker.file_command`, read as in step 1) |

## Checks the repository may already enforce

Several checklist items are often enforced by a workflow of their own. Look in
`.github/workflows/` for one; where it exists, confirm it runs on this change
and passes, and point the author at it, rather than checking by eye:

| Concern | Typical enforcing check |
|---------|-------------------------|
| Mutable (non-SHA) action references | an action-pin check over `.github/workflows/**` and `.github/actions/**`, or a workflow-convention lint |
| Job timeouts, cancelling pull-request concurrency, unfiltered required workflows, a `!cancelled()` aggregator, heavy suites off the per-change path, one key-affecting environment per cache group | a workflow-convention lint; Jig's reference is [M13's](https://github.com/docomply/jig/blob/main/modules/M13-pipeline-economy/reference/workflow-conventions/README.md), whose exceptions each carry a reason |
| A container build's cache mount on every step that reads the store, and no per-command store flag | a cache-mount check over the Dockerfiles; Jig's reference is [M13's](https://github.com/docomply/jig/blob/main/modules/M13-pipeline-economy/reference/cache-mount-coverage/README.md) |
| Expressions inside `run:`, over-broad permissions, secrets written to outputs, and `uses:` references a plain grep misses (YAML allows `uses : …`) | a static workflow auditor (for example zizmor) over `.github/workflows/` and `.github/actions/`, pinned to one version so finding counts stay comparable, each suppression with a reason; advisory until the tree is clean at the chosen level, blocking after |
| Unpinned `curl \| sh` or install scripts | an install-script allowlist |
| Merge strategy (for example squash-only) | a merge-strategy validation |
| Secrets leaked in the diff | a secret scan |

---

## Quick commands

```bash
# Recent workflow runs
gh run list --limit 10

# Recent runs of one workflow
gh run list --workflow <workflow>.yml --limit 5

# Runs waiting for a runner (that wait is outside timeout-minutes)
gh run list --status queued

# Dispatch from the branch whose workflow file is current (2.6)
gh workflow run <workflow>.yml --ref <branch> -f <input>=<value>

# Dry-run a workflow locally (needs the `act` tool)
act pull_request -W .github/workflows/<workflow>.yml --dryrun
```
