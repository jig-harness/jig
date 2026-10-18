# Pipeline economy — how our CI spends time and money

> Copy this into your repository (e.g. `docs/development/pipeline-economy.md`),
> fill in the tables, and delete the guidance quotes. It is the
> tool-independent policy; the per-provider wiring is in Jig's
> [M13 mappings](https://github.com/jig-harness/jig/blob/main/modules/M13-pipeline-economy/mappings.md),
> and the reasoning behind each rule in the
> [M13 module](https://github.com/jig-harness/jig/blob/main/modules/M13-pipeline-economy/README.md).

**The rule.** Spend CI only where it changes a merge decision, and never let a
saving turn a failure into a pass. What we check is decided by our gate set;
this page decides how cheaply and how fast it runs, without weakening it.

## 1. Honest signal

- The only required check is `<aggregator job name>`. It runs whenever the run
  was not cancelled and fails unless every job the change selected passed and
  every job it did not select was skipped.
- No workflow behind a required check is filtered by changed paths at its
  trigger. A filtered workflow never reports; a skipped required job counts
  as passing. Selection happens inside the workflow.

## 2. Select

- One resolver job per run reads `<path to the change-area catalog>` and
  publishes which areas changed. Jobs read its outputs and never repeat a
  path pattern of their own.
- A gate whose subject is one area keys off that area. A changed file that
  matches no area selects every job, or a gate fails the change until the
  file belongs to an area.
- A job installs its toolchain only when it has selected work to do.
- A push to `<integration branch>` checks every area (the backstop for checks
  scoped to the change).
- Before blaming a failure on a change, reproduce it on a freshly fetched
  `<integration branch>`. A failure that reproduces there is fixed or
  reported there.

## 3. Supersede

> One row per workflow. A run may share a slot only with runs it fully
> covers.

| Workflow | Concurrency key | Cancel in progress? | Why the surviving run covers the displaced one |
|----------|-----------------|---------------------|------------------------------------------------|
| `<pull-request workflow>` | workflow + pull request number | yes | the newer head contains everything the older one would have checked |
| `<post-merge verification>` | workflow + integration branch | no | each run checks the whole range since the last verified commit |
| `<manually dispatched workflow>` | workflow + run id | no | none: every dispatch runs |

## 4. Bound

Every job has a timeout, sized to about two to three times its slowest
healthy run, at most `<60>` minutes and never the provider's default. A
merged job's timeout is the sum of the timeouts it replaced; a suite that
outgrows its timeout is sharded.

> One row per job, or per family of jobs.

| Job | Usual duration | Timeout |
|-----|----------------|---------|
| `<resolver>` | `<1 min>` | `<5 min>` |
| `<gates and build>` | `<…>` | `<…>` |
| `<tests, per shard>` | `<…>` | `<…>` |

A scheduled watchdog fails when a job has waited for a runner longer than
`<45>` minutes, because job timeouts do not count that wait. Its failures go
to `<channel or alert>`.

## 5. Order and parallelize

- Cheapest checks first, before any dependency install.
- Independent jobs need only the resolver, so the run takes about as long as
  its slowest job.
- Suites longer than `<n>` minutes are sharded; matrices do not stop their
  other legs when one fails.

## 6. Where each suite runs

> The question for each suite: does a merge, or the verified pointer, wait
> for this answer? If not, it runs on a schedule or on demand, and a cheap
> proxy runs per change in its place.

| Suite | Placement | Who waits for it | Per-change proxy |
|-------|-----------|------------------|------------------|
| `<format, lint, types, unit tests, build>` | every pull request | the merge | — |
| `<integration tests, migration replay>` | every push to `<integration branch>` | the verified pointer | — |
| `<full end-to-end sweep>` | nightly, and on demand | no one | `<the end-to-end images still build>` |
| `<coverage>` | weekly, and on demand | no one | `<the unit tests, which already run on every pull request; coverage only measures them>` |

A scheduled suite reports its failures to `<channel or issue>`, and a
schedule that stopped running counts as failing.

## 7. Hold

> Delete this section if no review driver holds CI between review rounds.

The hold label is `<ci:hold>`; `<the review driver>` applies it once the
opening head's full run has completed and removes it when review converges.
While a pull request carries it:

- these jobs skip: `<e2e, …>`, each by testing the pull request's labels for
  the label, never by the event that started the run;
- `<the aggregator job>` fails at its first step with a message naming the
  label, so a held head is never mergeable;
- every workflow above runs on `labeled` and `unlabeled` as well as on
  `opened`, `synchronize` and `reopened`, so applying the label fails the
  head at once and removing it runs everything again on the same head.

Only results that started after the label's removal count. A driver that
died leaves the label on: remove it by hand
(`<gh pr edit <PR> --remove-label ci:hold>`); never rerun the held run, which
replays the event that carried the label. Merge queue:
`<how a queued pull request is released, or "no merge queue">`.

## 8. Caches

> One row per cache. A cache answers only for the inputs its key names,
> every pipeline that shares it keys it the same way, its size is bounded
> and its hit rate is seen, and only a trusted run writes to it. Delete
> the section if the pipeline uses no cache.

| Cache | Key covers | Shared by | Retention bound, enforced by | Hit rate reported in |
|-------|------------|-----------|------------------------------|----------------------|
| `<dependency store>` | `<the lockfile's hash, the runner's operating system, the toolchain version>` | `<pull-request and post-merge workflows>` | `<7 days unused, 10 gigabytes; the provider's eviction>` | `<the restore step's cache-hit output, in the job summary>` |
| `<task runner's remote cache>` | `<every tracked file of the package, the declared environment values, the lockfile>` | `<every workflow that runs the task runner>` | `<the service's own retention>` | `<hits and misses from the run summary, in the job summary>` |
| `<container layer cache>` | `<each instruction and the files it copies; the store on a cache mount>` | `<the image-build jobs>` | `<the builder's prune: entries older than 7 days>` | `<CACHED steps in the build log>` |
| `<shared local cache on developer machines>` | `<as the task runner's>` | `<every working copy of the clone>` | `<7 days by modification time; the scheduled prune>` | `<—>` |

- A job that shares `<the remote cache>` fails before its first task when
  `<the token, the team or the signature key>` is empty; the jobs are
  declared as one cache group for the workflow-convention lint.
- A result that went stale is fixed by completing the key. `<--force or the
  equivalent>` is never a standing fix.
- `<The remote cache>` is signed with `<the signature key>`; an entry that
  does not verify is recomputed. A pull request from a fork gets no cache
  credentials and runs uncached.
- Every step of a container build that reads the store mounts it; the
  cache-mount check runs on changes to `<the Dockerfiles>`.

## 9. Runner classes and parallelism

> One row per job, or per family of jobs. The jobs that only decide or
> report run on the smallest class; a larger class carries the measurement
> that earned it, and the decision is in the cost ledger.

| Job | Runner class | Measured work behind the class |
|-----|--------------|--------------------------------|
| `<resolver>`, `<aggregator>` | `<the smallest class>` | they decide or report; nothing to measure |
| `<gates and build>` | `<the smallest class>` | `<wall time at this class; processor use below half>` |
| `<tests, per shard>` | `<a 4-core class>` | `<wall time 9 min at 2 cores, 5 min at 4; ledger entry tests-on-4-cores>` |

On one machine, `<the task runner>`'s package concurrency (`<n>`) times each
package's worker cap (`<m>`) is at most the cores (`<n × m ≤ cores>`); the
cap is set in every package that invokes `<the test runner>`.

## 10. Legs before CI

CI is the authority for every check: its verdict on the merged head is the
one a merge waits for, and skipping a hook never changes what merges. Each
leg before it selects no more work than CI does for the same change.

| Leg | What it runs | How it selects | Holds a machine? |
|-----|--------------|----------------|------------------|
| pre-commit hook | `<format and the staged-file fixes>` | the staged files | no |
| pre-push hook | `<the fast gates>` | `<the resolver over the change-area catalog, as CI; or the task runner's changed-since filter>` | no |
| `<remote sandbox>` | `<the CI command list>` | `<the package list the dispatching leg resolved>` | yes: opt-in for `<the areas listed in the catalog>`, because `<the failure class it catches that CI cannot>`; reopen conditions in the ledger |

## 11. Cost

The measures below are collected by `<the scheduled job>` every `<week>`
from `<the provider's jobs and billing records>` and published in
`<the report or dashboard>`; each is a metric in `<the metrics registry>`.

| Measure | Metric | Window |
|---------|--------|--------|
| runner-minutes per pipeline and job | `ci-runner-minutes` | `<30 days>` |
| cost per change | `ci-cost-per-change` | `<30 days>` |
| queue wait | `ci-queue-wait` | `<30 days>` |
| cache hit rate | `ci-cache-hit-rate` | `<per run>` |

Every decision that changed what the pipeline spends (a resize, a leg
narrowed or added, a suite moved, a cache turned on) is an entry in
`<.config/ci-cost-ledger.yaml>` with its measurement before and after in one
unit and a reopen condition over one of the metrics above; the cost-ledger
check runs on changes to it, and a decision whose after-measurement is not
in by its due date fails the check.

## Checklist for a new or changed workflow

- [ ] No trigger-level path filter, if it reports a required check.
- [ ] Every job has a timeout with generous headroom over its slowest healthy
      run, never the provider's default.
- [ ] Its concurrency key names the ref, the event and every dispatch input
      (a dispatch keyed by its run id), and a cancelled run is always covered
      by the run that replaced it.
- [ ] Its jobs read the resolver's outputs rather than their own path
      patterns, and an unmatched file selects them (or fails the change).
- [ ] Its jobs are in the aggregator's `needs`, and the aggregator judges
      them by the resolver's selection.
- [ ] Its placement is in the table above.
- [ ] If a job of it is one the hold skips, or it reports a required check:
      it runs on both label events, the skip tests the pull request's labels
      for the hold label, and the held-head check's failure reaches the
      required check.
- [ ] If it uses a cache: the cache is in the table above with its key
      scheme and bound, its credentials are checked non-empty before the
      first task, its hit rate goes to the job summary, and its jobs are in
      the cache group the lint compares.
- [ ] Each job's runner class is in the table above; a job that only
      decides or reports is on the smallest class, and a larger class has
      its measurement and its ledger entry.
- [ ] If it runs a test runner under a task runner: the workers per package
      are capped and the product with the package concurrency is at or
      below the cores.
- [ ] If it changes what the pipeline spends: the ledger has the entry,
      with its before, its after or its due date, and its reopen condition.
