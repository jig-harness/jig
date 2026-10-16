# M13 — Pipeline economy

**What problem this solves.** [CI](../../GLOSSARY.md) costs money and, worse,
time: every pull request waits for it, and so does every agent driving one.
Left alone, a pipeline grows by addition. Every new check runs on every push,
whether or not the change could affect it. Five quick pushes run the full
pipeline five times, though only the last head will ever merge. A hung job
holds a runner until the provider's default limit, which can be hours away.
A half-hour end-to-end sweep runs per change although no one waits for its
answer. The usual cure makes things worse: a team that filters a slow
workflow by changed paths, or skips a job "when it is not needed", has
quietly turned some failures into passes: a skipped required job counts as
success, and a workflow that never started leaves its check waiting until
the team stops requiring it. This
module makes CI cheap and fast **without** weakening it: spend where the
answer changes a merge decision, and make every saving fail toward running
more, never toward a green check nobody earned.

## Invariant

> Spend CI only where it changes a merge decision, and never let a saving
> turn a failure into a pass.

**Boundary.** [M1](../M1-gates-enforcement-ladder/README.md) decides *what*
is checked and on which rung; M13 decides how cheaply and how fast it runs,
without weakening it. M13 never removes a check M1 requires; it decides where
and when that check runs, and makes sure the result still reaches the merge.

## Core pieces

Six sub-invariants. The first is the precondition for the other five: a
pipeline may only economize once it reports honestly.

### 1. Honest signal first

Every required check reports a verdict on every head.

- **Select inside the pipeline, never at its trigger.** A workflow behind a
  required check is never filtered by changed paths at trigger level. A
  filtered-out workflow never
  starts, so it never reports: its required check waits forever, and the team
  learns to stop requiring it. Jobs are selected inside the workflow instead.
- **One always-running [aggregator job](../../GLOSSARY.md) is the required
  check.** Where each job reports its own check, a job skipped by its
  condition reports success to the merge rule, so the individual,
  sometimes-skipped jobs are never required directly. One aggregator job
  waits for all of them and turns their results into one verdict: a job the
  change selected must succeed; a job the change did not select must be
  skipped; a failed, cancelled or missing answer fails the verdict, and so
  does a selection the resolver could not make. A provider that judges the
  whole pipeline has this verdict built in.
- **The aggregator runs whenever its run was not cancelled, not
  unconditionally.** An unconditional aggregator also runs when a newer push
  cancelled the run, and then reports a failure for a head that is already
  superseded.
- **The aggregator's exit code is the verdict.** A summary that only prints
  the failures, from a step allowed to fail, blocks nothing.

[M1's pull-request workflow skeleton](../M1-gates-enforcement-ladder/templates/ci-pr-gates.yml)
has the resolver and aggregator in this shape;
[mappings.md](mappings.md#honest-signal) maps them per CI provider. A held
head (the [CI hold](../../GLOSSARY.md)) applies the same rule: it fails a
required check rather than skipping it.

### 2. Select

Run what the change needs, decided once, failing toward running more.

- **One resolver per run**, in the smallest job, reads the
  [change-area catalog](../M3-change-area-catalog/README.md) (M3) and
  publishes which areas the change touches. Every other job reads its
  answer; no job re-derives "what changed" with its own path pattern, because
  copies of a pattern drift apart.
- **Each gate is selected by its own subject, and selection fails closed.** A
  gate whose subject is one area keys off that area, not off a broader "code
  changed" flag that someone may later narrow for another reason. Gates use
  the resolved closure of areas, not only the areas a file matched directly;
  M3's [resolver](../M3-change-area-catalog/README.md#core-pieces) defines the
  closure. A changed file that matches no area selects every job, or a gate
  fails the change until the file belongs to an area.
- **A job pays for toolchain setup only when selected work exists.** The
  resolver job installs only what the resolver needs; a job whose steps are
  all deselected skips the install too, rather than installing a toolchain to
  learn there is nothing to do.
- **Consolidate one-command satellite workflows.** Each separate workflow
  pays its own checkout, toolchain and install to run one command. Fold them
  into one workflow behind the same resolver, and delete a check that a
  required gate already runs: it costs a second time and enforces less.
- **Scoped checks need an unscoped backstop on the integration branch.** A
  check scoped to the changed areas never runs for a change elsewhere, so the
  integration branch can go red without any pull request going red. A run on
  the integration branch checks everything (or the whole unverified range,
  below).
- **Attribute a failure to a change only after reproducing it on a freshly
  fetched base.** A failure that also occurs on the base belongs to the base:
  fix or report it there, rather than working around it in an unrelated
  change.

### 3. Supersede

Cancel a run only when another run covers it.

- **Two runs share a [concurrency group](../../GLOSSARY.md) only if the
  surviving run covers
  everything the displaced run would have checked.** A newer push to a pull
  request covers the older head, so pull-request runs cancel in progress. A
  manual run with different inputs, or a run from another branch, covers
  nothing of another: it gets its own slot.
- **A concurrency key includes the ref or commit, the event, and every
  dispatch input.** A manually dispatched run is keyed by its own run id, not
  by its inputs interpolated into the key.
- **A queue may keep only the newest waiting run per key.** On some
  providers a newer run cancels the older waiting one even where running
  ones are never cancelled, and nothing reports it as an error. A key that
  collides drops a requested run silently, which is why the run id keys a
  dispatch.
- **Serialized post-merge verification checks the whole unverified range.** A
  queue that keeps only the newest pending run is safe only when that run
  checks every commit since the last verified one
  ([M10's verified pointer](../M10-environments-deploy/README.md)), never
  just the newest commit. A run that cannot cover the range (a dispatch from
  another branch) gets a slot of its own, so it cannot displace one that
  does.

### 4. Bound

- **Every job has a timeout, without exception.** A job with none runs until
  the provider's default limit, often hours, so one hung test or stuck
  download holds a runner, and its cost, for that long before anything
  fails. Where a job only hands its work to another pipeline, the jobs that
  do the work carry the timeout
  ([mappings](mappings.md#bound) has each provider's default and syntax).
- **The timeout is generous, never the default.** Size it to about two to
  three times the slowest healthy run, rounded up, and at most an hour. Its
  work is to stop a hang, not to police a slow day: a tight limit fails
  healthy runs on a busy runner, and the re-run costs more than the headroom
  saved. A suite with a tight time budget
  ([M14](../M14-testing-strategy/README.md)) enforces it at its own step, and
  the job timeout stays the backstop around it. When two jobs merge into one,
  the new timeout is the sum of theirs, not a round number. A suite that
  outgrows its timeout is sharded, not given a longer one: a job that needs
  more than an hour is the sign, and one that truly cannot be split carries a
  reasoned exception in the
  [workflow-convention lint](reference/workflow-conventions/README.md#job-timeout).
  The lint checks that every job has a timeout and that none exceeds the
  hour; it cannot see run durations, so the two-to-three-times sizing stays
  the author's to apply.
- **A watchdog bounds [queue stalls](../../GLOSSARY.md) and fails loudly.**
  A job timeout counts
  only time the job runs, not time it waits for a runner. A job waiting for a
  runner that never comes holds its concurrency slot, and every newer run
  queues behind it, for hours, while nothing fails. A scheduled watchdog
  fails when a job has been queued longer than a set bound:
  [`reference/queue-watchdog/`](reference/queue-watchdog/) with the workflow
  [`templates/queue-watchdog.yml`](templates/queue-watchdog.yml). For
  serialized post-merge verification, [M10's watchdog](../M10-environments-deploy/README.md#the-watchdog-decides-by-cause)
  applies the same bound and cancels the stalled run, which is safe because
  every verification run covers the whole unverified range.

### 5. Order and parallelize

- **Cheapest checks first**: the gates that fail in seconds run before any
  dependency install is paid for (M1's gate order).
- **The critical path in parallel**: independent jobs need only the resolver,
  not each other, so the run takes about as long as its slowest job.
- **Long suites sharded** across parallel jobs, each shard with its own
  timeout ([test shard](../../GLOSSARY.md)).
- **Every independent failure reported in one run**: a matrix does not stop
  its other legs when one fails, so one push shows the
  author every problem instead of one per round trip.

### 6. Place

Each suite runs where its answer is needed. The question is: **does a merge,
or the [verified pointer](../M10-environments-deploy/README.md), wait for
this answer?**

| Placement | What runs there | Example |
|-----------|-----------------|---------|
| Every pull request | the gates the merge waits for, selected by what changed, and a cheap proxy for each heavy suite placed elsewhere | format, lint, types, unit tests, build; "the end-to-end images still build" |
| Every push to the integration branch | what the verified pointer waits for, over the whole unverified range, and the unscoped backstop | integration tests against real services, migration replay, artifact build, end-to-end tests of journeys nothing else checks |
| On a schedule | slow suites nothing waits for, and trends | the full end-to-end sweep against a deployed environment, nightly; coverage, weekly |
| On demand | the scheduled suites, run by hand when a change needs them now | a manual dispatch naming the suite |

- **A cheap per-change proxy stands in for each heavy suite** moved off the
  per-change path: it catches the breakage a change can cause cheaply (the
  suite no longer compiles, its images no longer build) and leaves the
  expensive question to the schedule. A trend measured over a suite that already
  gates every change, such as coverage over the unit tests, has that suite
  as its proxy.
- **The placement is enforced, not remembered.** A heavy suite that gains a
  per-change trigger drifts back into everyone's wait; a check on the
  workflow files rejects it (the
  [workflow-convention lint](reference/workflow-conventions/README.md#heavy-per-change)). A scheduled suite reports its failures where
  someone will see them, and a schedule that stopped running counts as
  failing.

The copyable policy page,
[`templates/PIPELINE-ECONOMY.md`](templates/PIPELINE-ECONOMY.md), carries
this table with the other rules, for a team to fill in with its own suites.
[M14 (Testing strategy)](../M14-testing-strategy/README.md) gives each suite
the tier and time budget that decide its row.

## Maturity levels

- **Lite** — a new push to a pull request cancels the runs for its older head;
  every job has its own timeout, below the provider's default; no workflow
  behind a required check is filtered by changed paths at its trigger.
- **Standard** — a resolver reading the change-area catalog drives job
  selection, failing closed; one aggregator job is the required check; slow
  suites no merge waits for run on a schedule, with a cheap per-change proxy.
- **Strict** — the workflow conventions are checked by a lint that fails
  closed on input it cannot parse and accepts only reasoned exceptions, which
  fail once they suppress nothing, and it fails a job timeout above an hour;
  CI time or cost is measured per workflow
  and job; a queue-stall watchdog runs.

The criteria are in
[`M13-pipeline-economy.yaml`](../../plugin/skills/audit/criteria/M13-pipeline-economy.yaml).
A repository without CI has no pipeline to economize: the module is
expected-absent there.

## Adoption steps

1. Make every required check honest first: remove trigger-level path filters
   from the workflows behind required checks, put one aggregator in front of
   them, and require only the aggregator
   ([M1's skeleton](../M1-gates-enforcement-ladder/templates/ci-pr-gates.yml)
   has the shape). Give every job a generous timeout and every pull-request workflow
   a cancelling concurrency group. This is **Lite**.
2. Write a change-area catalog ([M3](../M3-change-area-catalog/README.md)) if
   there is none, and select jobs from one resolver job; gate the toolchain
   setup on selected work. Copy
   [`templates/PIPELINE-ECONOMY.md`](templates/PIPELINE-ECONOMY.md), fill in
   the placement table, and move each slow suite nothing waits for to a
   schedule with a per-change proxy. This is **Standard**.
3. Check the conventions with a lint over the workflow files
   ([`reference/workflow-conventions/`](reference/workflow-conventions/README.md)),
   measure CI time per workflow and job, and run the queue-stall watchdog.
   This is **Strict**.

## Status

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/PIPELINE-ECONOMY.md`](templates/PIPELINE-ECONOMY.md) | The copyable policy page: the six rules, the placement table to fill in, and a checklist for a new or changed workflow |
| [`templates/queue-watchdog.yml`](templates/queue-watchdog.yml) | A scheduled GitHub Actions workflow that runs the queue-stall check |
| [`reference/queue-watchdog/`](reference/queue-watchdog/) | The queue-stall check: fails when a job has waited for a runner longer than a bound; with its self-test |
| [`reference/workflow-conventions/`](reference/workflow-conventions/README.md) | The workflow-convention lint behind the Strict level: job timeouts, cancelling pull-request concurrency, unfiltered required workflows and `!cancelled()` aggregators, the CI hold's guard and sentinel, heavy suites off the per-change path, cache-environment parity, commit-pinned actions ([M1's piece 7](../M1-gates-enforcement-ladder/README.md#core-pieces) says why), and path filters that match each other and the change-area catalog; reasoned, self-pruning exceptions; with its self-test. Jig's own workflows pass it in `bun run gates` |
| [`mappings.md`](mappings.md) | Each sub-invariant on GitHub Actions and GitLab CI, with the syntax and provider behaviour this page leaves out |
| [maturity criteria](../../plugin/skills/audit/criteria/M13-pipeline-economy.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

The resolver and the aggregator are not repeated here: the aggregator's shape
is in [M1's skeleton](../M1-gates-enforcement-ladder/templates/ci-pr-gates.yml),
the catalog and resolver are [M3](../M3-change-area-catalog/README.md)'s, and
the verified pointer and its post-merge range are
[M10](../M10-environments-deploy/README.md)'s. The
[`/jig:github-actions`](../../plugin/skills/github-actions/SKILL.md) skill
reviews workflow changes, and Jig's own
[`gates` workflow](../../.github/workflows/gates.yml) is a worked example of
sub-invariants 1, 2 and 4, and of sharding a long suite.

### Left out by design

- **What is checked.** Which gates exist and on which rung they sit is
  [M1](../M1-gates-enforcement-ladder/README.md)'s; M13 never trades a gate
  away for speed.
- **Repositories without CI.** Nothing to economize; the module is
  expected-absent.

### Future

These parts of pipeline economy are planned in the [roadmap](../../ROADMAP.md)
and land here as their own work:

- **The CI hold** as a documented practice, with guard expressions; drive-pr's
  `ci.hold_label` is its runnable side today.
- **Caches**: complete keys, one shared namespace, bounded retention, a
  reported hit rate, and a trust boundary.
- **Cost and sizing**: runner sizes, one authoritative run of each check, and
  cost measured with the conditions that reopen a decision.
- **The lint on GitLab CI**: the workflow-convention lint reads GitHub
  Actions files only.
