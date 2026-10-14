# Pipeline economy — how our CI spends time and money

> Copy this into your repository (e.g. `docs/development/pipeline-economy.md`),
> fill in the tables, and delete the guidance quotes. It is the
> tool-independent policy; the per-provider wiring is in Jig's
> [M13 mappings](https://github.com/docomply/jig/blob/main/modules/M13-pipeline-economy/mappings.md),
> and the reasoning behind each rule in the
> [M13 module](https://github.com/docomply/jig/blob/main/modules/M13-pipeline-economy/README.md).

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

> One row per job, or per family of jobs. A merged job's timeout is the sum
> of the timeouts it replaced; a suite that outgrows its timeout is sharded.

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

## Checklist for a new or changed workflow

- [ ] No trigger-level path filter, if it reports a required check.
- [ ] Every job has a timeout sized to its work.
- [ ] Its concurrency key names the ref, the event and every dispatch input
      (a dispatch keyed by its run id), and a cancelled run is always covered
      by the run that replaced it.
- [ ] Its jobs read the resolver's outputs rather than their own path
      patterns, and an unmatched file selects them (or fails the change).
- [ ] Its jobs are in the aggregator's `needs`, and the aggregator judges
      them by the resolver's selection.
- [ ] Its placement is in the table above.
