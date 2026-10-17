# M13 — Pipeline economy

**What problem this solves.** [CI](../../GLOSSARY.md) costs money and, worse,
time: every pull request waits for it, and so does every agent driving one.
Left alone, a pipeline grows by addition. Every new check runs on every push,
whether or not the change could affect it. Five quick pushes run the full
pipeline five times, though only the last head will ever merge. A hung job
holds a runner until the provider's default limit, which can be hours away.
A half-hour end-to-end sweep runs per change although no one waits for its
answer. A build cache whose key leaves out an input answers a change with
a result computed for another one, and the usual cure, switching the cache
off, pays the full price on every run. The other usual cure makes things
worse: a team that filters a slow
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

The sub-invariants below. The first is the precondition for the rest: a
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
head (the [CI hold](../../GLOSSARY.md), piece 7) applies the same rule: it
fails a required check rather than skipping it.

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
- **A run executes the pipeline definition of one ref, and it is the ref
  whose gates are wanted.** A run started by hand executes the definition of
  the ref it was started from, so starting it from a branch that lags the
  integration branch runs an old definition and skips the gates added since,
  and nothing says so. A run started by another run's completion executes
  the default branch's definition whatever branch the triggering run was on,
  so a condition on the run's own ref checks nothing about the triggering
  run ([mappings](mappings.md#place) has each provider's behaviour).

The copyable policy page,
[`templates/PIPELINE-ECONOMY.md`](templates/PIPELINE-ECONOMY.md), carries
this table with the other rules, for a team to fill in with its own suites.
[M14 (Testing strategy)](../M14-testing-strategy/README.md) gives each suite
the tier and time budget that decide its row.

### 7. Hold

A pull request under review takes several [rounds](../../GLOSSARY.md)
([M7](../M7-pr-lifecycle-review/README.md)), and each push between rounds
is an intermediate head no one will merge; yet each runs the whole
pipeline, heavy suites included, while the reviewer only needs the cheap
signal. The first instinct, skipping the heavy jobs on those pushes, is the
saving piece 1 forbids: a skipped required job counts as a pass, so an
intermediate head with a broken suite looks mergeable. The
[CI hold](../../GLOSSARY.md) is the one shape in which that saving is safe:
a label on the pull request that the pipeline honours, applied by the
review driver once the opening head's full run has completed and removed
when review converges.

> A pipeline may suppress expensive work on an intermediate head only while
> a required check fails on that head, and only until a release that runs
> everything again.

Every one of these holds, or the saving turns a failure into a pass:

- **A required check fails, never skips, on every held head, from the
  instant the hold is applied.** One step in the required job, or in a job
  it needs directly while itself running on `!cancelled()`, fails while the
  label is present: the [held-head check](../../GLOSSARY.md). The pipeline
  runs on the label's application, so the opening head's green is replaced
  at once rather than at the next push, which may never come. A held head
  is visibly not mergeable from the first second to the release.
- **Only the hold's own label skips work.** Each heavy job skips by testing
  whether the pull request carries the hold label, never by the kind of
  event that started the run. The pipeline now runs on every label event,
  and a run's result replaces the head's previous one, so a job that
  skipped on any `labeled` event would let an unrelated label turn a
  failing head into a passing skip. An unrelated label event on an unheld
  pull request therefore runs real CI: the price of a run whose result
  counts.
- **Releasing the hold reruns every required check on the same head.**
  Every workflow that honours the label, and every one reporting a required
  check, runs on the label's removal, in full: the released head is the one
  the merge waits for, and a check that does not run again leaves the
  driver waiting for a result that never comes.
- **The driver certifies only results that started after the release.** The
  held runs reported on the same head under the same check names, so the
  driver reads when the label was removed and accepts only check runs that
  started after it; one that started in the same second is rerun.

The held-head check's message says why the head failed and how to release
it: the label's name, and that removing it runs everything again. A driver
that dies mid-round leaves the label on, and the pull request stays red
until someone removes it; removing it by hand is the release and reruns
everything. Never rerun the old run instead: a rerun replays the event that
carried the label and fails on the same step.

**Open question: merge queues.** A merge-queue run carries no pull-request
labels, so it neither skips nor fails on the hold; what a hold means once a
pull request is queued, and whether the queue's own run is the release, has
no evidence yet. A repository with a merge queue records its answer in its
policy page.

The driver side is the [`drive-pr`](../../plugin/skills/drive-pr/README.md#ci-hold)
skill (`ci.hold_label`); the workflow side is an opt-in block in
[M1's skeleton](../M1-gates-enforcement-ladder/templates/ci-pr-gates.yml);
[mappings.md](mappings.md#hold) gives the trigger, guard and held-head
check per provider; the
[workflow-convention lint](reference/workflow-conventions/README.md#ci-hold)
checks all three in the one shape it can prove safe.

### 8. Cache

A build cache is the saving that hides best. A stale entry fails no check:
it answers the change with a result computed for other inputs, and the run
is green. A cache that misses on every run fails nothing either: the run
is slow, and everyone believes the cache is on. One pipeline can write
entries that no other pipeline ever reads, for months, with the only
symptom a hit rate no one looks at. So a cache earns its place with a key
that covers everything, one namespace for everyone meant to share it, a
bound on its size with its hit rate in view, and a line around who may
write to it.

> A cache answers only for the inputs its key names, every pipeline that
> shares it keys it the same way, its size is bounded and its hit rate is
> seen, and only a trusted run writes to it.

- **Complete keys.** The [cache key](../../GLOSSARY.md) covers every input
  that changes the output: the sources, the lockfile, the toolchain, and
  the *values* of the environment variables the task reads, not only their
  names. A task runner that hashes a package's whole file set needs no
  input list that can leave a file out; a tool that hides undeclared
  variables from a task hides them from the key as well, so a variable the
  task reads is declared where both see it. A result that went stale is
  fixed by completing the key, never by disabling the cache or forcing a
  rerun: a standing force pays the full price on every run and leaves the
  hole open for the next task to fall into.
- **One namespace.** Every pipeline meant to share a cache produces an
  identical key-affecting environment: the same declared variables with the
  same values, the same credentials. A provider substitutes an empty string
  for a secret that is absent or rotated out rather than failing, and a
  cache tool rarely fails on it either, so a job with an empty credential
  splits off without a word: depending on the tool, it runs without the
  shared cache (every task a miss, nothing it computes shared), or, where
  the credential's value selects the store or enters the key, it reads and
  writes a [cache namespace](../../GLOSSARY.md) of its own that no other
  pipeline reads. A missing credential therefore fails the job before its
  first task; what each tool does without one is in
  [mappings.md](mappings.md#cache). The declared environment of the jobs that share a cache is compared
  by a lint (the [workflow-convention lint](reference/workflow-conventions/README.md#cache-env-parity)'s
  cache groups); the run-time value is the job's own check. Where a tool
  shares its cache across working copies by itself, nothing in the
  configuration may switch that off: the feature is invisible when it
  works, so a test pins the setting that would.
- **Bounded and measured.** Every cache has written down its
  key scheme, with the naming convention that keeps two jobs' entries
  apart; a retention bound, enforced by the store's own eviction or by a
  scheduled prune; and its [hit rate](../../GLOSSARY.md), reported on every
  run in the run's summary as hits and misses. A cache nobody bounds grows
  without limit, a shared one fastest of all, and the bound is set short on
  purpose: evicting early costs one recomputed miss; keeping too long costs
  disk no one reclaims. The hit rate is what
  detects what nothing else does: a cache that is declared but stores
  nothing (an exporter configured for a builder that never writes it) and a
  split namespace (one pipeline at zero hits while another is at every
  hit). A cache wired on some steps and not on others fails outright
  instead: a build step reading a store that another step mounted sees an
  empty directory, and the error names a missing package, not a missing
  mount. [`reference/cache-mount-coverage/`](reference/cache-mount-coverage/README.md)
  checks a container build's [cache mounts](../../GLOSSARY.md) on every
  step that reads the store.
- **Trust boundary.** Only a trusted context writes to a shared cache, and
  a run verifies what it reads: entries are signed with a key the trusted
  contexts hold, and an entry that does not verify is recomputed, so a
  tampered or cross-context artifact is never served as a result. An
  untrusted run (a pull request from a fork) gets no cache credentials; a
  context that cannot carry credentials runs uncached rather than under a
  namespace of its own, so its results are honest and its misses visible,
  not written to a cache no one reads.

The policy page ([`templates/PIPELINE-ECONOMY.md`](templates/PIPELINE-ECONOMY.md))
carries the table of caches with their key schemes, bounds and reports;
[mappings.md](mappings.md#cache) maps these rules onto the task runners,
build tools and CI providers; [M1's skeleton](../M1-gates-enforcement-ladder/templates/ci-pr-gates.yml)
has the credential check and the hit-rate report as an opt-in block; the
hit rate is an [M11](../M11-process-observability/README.md) metric
(`ci-cache-hit-rate` in its registry template); and the
[`/jig:github-actions`](../../plugin/skills/github-actions/SKILL.md) skill
checks them on a workflow change.

### 9. Size

A runner is bought by the minute, in classes, and the class a job runs on
is a decision with a number behind it, like its timeout. Without the
number, two shapes recur. A job that only decides or reports (the resolver,
the aggregator, an echo job) runs for seconds on the largest class, because
the workflow was given one class throughout, and pays that class's rate for
work a smaller one would not notice. And a test runner that forks a worker
per core, run by a task runner that runs several packages at once, puts
packages times workers processes on the machine's cores: load spikes,
every suite slower, timeouts that fail healthy runs. The second one does not
look like a sizing problem; it looks like flaky tests.

> A job's runner class follows its measured work, the smallest class serves
> the jobs that only decide or report, every resize carries the measurement
> behind it, and a machine's parallelism is set once, as a product bounded
> by its cores.

- **The class follows the work.** Measure before sizing: the job's wall
  time, its processor use and its memory at the class it runs on. A job
  that is processor-bound and parallel gains from a larger class; a job that
  waits on the network, or runs one thing at a time, does not, and a larger
  class costs it the same minutes at a higher rate. The resolver, the
  aggregator and every other job that only decides or reports run on the
  smallest [runner class](../../GLOSSARY.md) the pool offers.
- **Every resize carries its measurement.** A change of class is written
  where the job's timeout is (the policy page's table), with the wall time
  and the [runner-minutes](../../GLOSSARY.md) before and after and the
  condition that reopens it (piece 11). A resize without a number is a
  guess, and the next person guesses again.
- **Parallelism is one product per machine.** The task runner's package
  concurrency times each package's worker count is at most the machine's
  cores. A test runner's default is a worker per core *per package*, and a
  task runner's default runs several packages at once, so the two defaults
  multiply. The per-package cap is set in the configuration of every
  package that invokes the test runner (the set is derived from the
  packages' test scripts; a glob over configuration file names both
  over- and under-counts), and the package concurrency in the one script
  that runs the suite. [mappings.md](mappings.md#size) has each tool's
  setting.

### 10. One authoritative leg

A check can run in several places for one change: in the editor, in a
pre-commit or pre-push hook, in a remote sandbox before the push, and in CI.
Each place is a [verification leg](../../GLOSSARY.md), and only one is the
authority: CI, on the head that merges. The others give earlier feedback.
Left alone, the legs before CI grow wider than CI: the hook runs the whole
repository's tests while CI selects the changed packages and their
dependents, so for a change inside one package the hook selects every
suite where CI selects one, and pays for answers the authority will not
use. A remote
sandbox that mirrors CI on every push holds a machine for about what a CI
run costs, while CI runs on the push regardless, so its only payback is a
push CI would have failed.

> CI is the single authority for each check; every leg before it selects no
> more work than CI does for the same change; and a leg that holds a machine
> beyond CI runs only where it is measured to catch what CI cannot, under
> reopen conditions that can be checked.

- **One authority.** The verdict a merge waits for is CI's on the head that
  merges ([M1](../M1-gates-enforcement-ladder/README.md)). A hook that
  passed changes nothing about what merges, and one that failed saved a
  round trip; so hooks and sandboxes are feedback, and skipping one never
  changes what merges.
- **No wider than CI.** A leg before CI selects its work the way CI does
  for the same change: the same resolver over the
  [change-area catalog](../M3-change-area-catalog/README.md), or the same
  changed-since filter of the task runner. A leg that selects more pays for
  answers the authority will not use; one that selects less is still safe,
  because CI is behind it. Where a wider run is wanted because CI's
  selection may miss a coupling it cannot see (an undeclared dependency, a
  file outside every package), the run is widened in CI, where it is
  authoritative, not in a hook. A remote sandbox without the repository's
  history cannot resolve a changed-since filter, so the leg that dispatches
  it resolves the selection first and sends the package list.
- **A costly extra leg is an opt-in with reopen conditions.** A leg that
  holds a machine per push (a sandbox on a machine like CI's) runs only
  where the record shows a class of failure CI alone would miss or a hook
  cannot reproduce: an opt-in per change area, never a default. The decision
  writes a [reopen condition](../../GLOSSARY.md) in each direction: what
  turns the leg on for an area (a CI-only failure class recurring on its
  changes after the hook passed them), and what turns it off again (the
  leg's share of the period's runner-minutes). What such a leg still
  offers is a place to reproduce a CI-only failure by hand on a machine
  like CI's: an escalation, not a step every change pays.

### 11. Measure

Every piece above trades something, and a trade without a number is
re-argued at each round. The measurement is cheap: the provider records
when each job started and finished and on which class; the cost is in not
reading it.

> Pipeline cost is measured on a cadence, per pipeline and per job, and
> every optimization records its measurement before and after with the
> threshold that reopens it.

- **On a cadence.** Runner-minutes per pipeline and per job
  (where the time goes: two jobs are usually most of it); the
  [cost per change](../../GLOSSARY.md), runner-minutes per merged change,
  the number that makes a per-push leg comparable with CI; queue wait, the
  time between a job's creation and its start, which piece 4's watchdog
  bounds and whose trend says whether the pool is sized right; and the
  cache hit rate (piece 8). A scheduled job collects them from the
  provider's records and publishes a report; each is a registered
  [M11](../M11-process-observability/README.md) metric.
- **Before and after, in one unit.** Every optimization, a resize, a leg
  narrowed or added, a suite moved to a schedule, a cache turned on, records
  the measurement that motivated it and the measurement after it, in the
  same unit over comparable windows: a median against a mean is not a
  comparison, and two windows that overlap are not a before and an after.
  A decision whose after is not yet measured says by when it will be, and
  the ledger fails once that date passes.
- **With the threshold that reopens it.** Each decision names what would
  make the team revisit it: a registered metric, a comparator, a threshold
  and a window, so the next person checks it instead of re-arguing it.
  "Reopen when the sandbox holds more than a tenth of the month's
  runner-minutes" is checkable; "reopen if it gets expensive" is not, and a
  condition over a metric nobody collects is dark. The decisions live in a
  [cost ledger](../../GLOSSARY.md)
  ([`templates/ci-cost-ledger.yaml`](templates/ci-cost-ledger.yaml)), and
  [`reference/cost-ledger/`](reference/cost-ledger/README.md) fails an
  entry without its measurements, with a reopen condition that is not
  checkable, or whose metric the registry does not carry.

## Maturity levels

- **Lite** — a new push to a pull request cancels the runs for its older head;
  every job has its own timeout, below the provider's default; no workflow
  behind a required check is filtered by changed paths at its trigger.
- **Standard** — a resolver reading the change-area catalog drives job
  selection, failing closed; one aggregator job is the required check; slow
  suites no merge waits for run on a schedule, with a cheap per-change proxy;
  where a CI hold is used, a required check fails on every held head from
  the instant the hold is applied, the pipeline runs on both label
  transitions, and only the hold's own label skips work; every cache has a
  written key scheme covering the inputs that change its output,
  environment values included, pipelines that share a cache produce one
  key-affecting environment and a job with an empty cache credential fails,
  and each run reports its hit rate; each job's runner class is written with
  the measurement behind it, the jobs that only decide or report run on the
  smallest class, and a machine's parallelism is set once as a product at
  or below its cores; CI is the written authority for every check, each leg
  before it selects no more than CI does for the same change, and a leg
  that holds a machine beyond CI is an opt-in recorded with what it catches
  and what reopens it.
- **Strict** — the workflow conventions are checked by a lint that fails
  closed on input it cannot parse and accepts only reasoned exceptions, which
  fail once they suppress nothing, and it fails a job timeout above an hour;
  where a CI hold is used, the lint checks its label events, its guard and
  its held-head check; every cache has a retention bound that a prune or
  the store's eviction enforces, a declared cache that stores nothing is
  detected, a container build's cache mounts are checked on every step
  that reads the store, and only trusted contexts write to a shared cache
  whose entries are verified; CI cost is measured on a cadence as
  runner-minutes per pipeline and job, cost per change, queue wait and hit
  rate, each a registered metric; every decision that changed what the
  pipeline spends is in a ledger with its measurement before and after and
  a reopen condition over a registered metric, and a gate fails an entry
  without them; a queue-stall watchdog runs.

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
   schedule with a per-change proxy. Where the merge waits for a heavy
   suite and review takes rounds, add the CI hold in the shape of piece 7
   (the opt-in block in M1's skeleton), and only in that shape. For each
   cache the pipeline uses (the dependency store, the task runner's cache,
   a container build's layers), write its key scheme in the policy page,
   declare the jobs that share it as a cache group for the lint, fail the
   job on an empty cache credential, and write the hit rate into the run's
   summary (piece 8; the opt-in block in M1's skeleton). Put the resolver
   and the aggregator on the smallest runner class, write each job's class
   in the policy page's table with the measurement behind any larger one,
   and cap the test runner's workers per package so the product with the
   task runner's concurrency stays at or below the cores (piece 9). Scope
   the pre-push hook and any sandbox by the same resolver or filter CI
   uses, and write that CI is the authority (piece 10). This is
   **Standard**.
3. Check the conventions with a lint over the workflow files
   ([`reference/workflow-conventions/`](reference/workflow-conventions/README.md)),
   bound each cache's retention with a prune or the store's eviction and
   record the window, sign the shared cache and keep its credentials from
   untrusted runs, run the cache-mount check over the container builds
   ([`reference/cache-mount-coverage/`](reference/cache-mount-coverage/README.md)),
   collect runner-minutes per pipeline and job, cost per change, queue
   wait and hit rate on a schedule into M11's registry, start the cost
   ledger ([`templates/ci-cost-ledger.yaml`](templates/ci-cost-ledger.yaml))
   with the decisions already taken and run its check
   ([`reference/cost-ledger/`](reference/cost-ledger/README.md)) on changes
   to it, and run the queue-stall watchdog. This is **Strict**.

## Status

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/PIPELINE-ECONOMY.md`](templates/PIPELINE-ECONOMY.md) | The copyable policy page: the rules, the placement table to fill in, the hold's label and jobs, the caches with their key schemes, bounds and reports, the runner class and parallelism of each job, the legs before CI and their scope, the cost measures and their cadence, and a checklist for a new or changed workflow |
| [`templates/ci-cost-ledger.yaml`](templates/ci-cost-ledger.yaml) | The copyable cost ledger: one entry per decision that changed what the pipeline spends, with its measurement before and after and the reopen condition over a registered metric |
| [`templates/queue-watchdog.yml`](templates/queue-watchdog.yml) | A scheduled GitHub Actions workflow that runs the queue-stall check |
| [`reference/queue-watchdog/`](reference/queue-watchdog/) | The queue-stall check: fails when a job has waited for a runner longer than a bound; with its self-test |
| [`reference/cost-ledger/`](reference/cost-ledger/README.md) | The cost-ledger check: fails a decision without its measurement before and after, with an after-measurement past its due date, with a reopen condition that names no metric, comparator, threshold and window, or whose metric the registry does not carry; fails closed on a ledger it cannot read or that has no `decisions` list, and passes an empty list (no cost decision yet); with its self-test |
| [`reference/cache-mount-coverage/`](reference/cache-mount-coverage/README.md) | The cache-mount check: fails a container build whose dependency store is on a cache mount that a step reading the store does not carry, or that is pinned by a per-command flag; fails closed on a Dockerfile it cannot read; with its self-test |
| [`reference/workflow-conventions/`](reference/workflow-conventions/README.md) | The workflow-convention lint behind the Strict level: job timeouts, cancelling pull-request concurrency, unfiltered required workflows and `!cancelled()` aggregators, the CI hold's label events, guard and held-head check, heavy suites off the per-change path, cache-environment parity, commit-pinned actions ([M1's piece 7](../M1-gates-enforcement-ladder/README.md#core-pieces) says why), and path filters that match each other and the change-area catalog; reasoned, self-pruning exceptions; with its self-test. Jig runs it over its own workflows |
| [`mappings.md`](mappings.md) | Each sub-invariant on GitHub Actions and GitLab CI, the cache rules on the task runners and build tools, the runner classes and parallelism settings by vendor and tool, and the cost measures by provider, with the syntax and provider behaviour this page leaves out |
| [maturity criteria](../../plugin/skills/audit/criteria/M13-pipeline-economy.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

The resolver and the aggregator are not repeated here: the aggregator's shape
is in [M1's skeleton](../M1-gates-enforcement-ladder/templates/ci-pr-gates.yml),
and so is the CI hold's wiring, as an opt-in block;
the catalog and resolver are [M3](../M3-change-area-catalog/README.md)'s, and
the verified pointer and its post-merge range are
[M10](../M10-environments-deploy/README.md)'s. The
[`/jig:github-actions`](../../plugin/skills/github-actions/SKILL.md) skill
reviews workflow changes, and Jig's own
[`gates` workflow](../../.github/workflows/gates.yml) is a worked example of
sub-invariants 1, 2 and 4, and of sharding a long suite. The CI hold's
driver side and the cost metrics are not repeated here either: the former
is drive-pr's, the latter M11's (`ci-runner-minutes`,
`ci-sandbox-minutes-share`, `ci-cost-per-change`, `ci-queue-wait` and
`ci-cache-hit-rate` in its registry template). The
hooks that run the leg before CI are M1's, and their scope comes from M3's
catalog.

### Left out by design

- **What is checked.** Which gates exist and on which rung they sit is
  [M1](../M1-gates-enforcement-ladder/README.md)'s; M13 never trades a gate
  away for speed.
- **Repositories without CI.** Nothing to economize; the module is
  expected-absent.

### Future

Not in the module yet; each lands as its own work:

- **The lint on GitLab CI**: the workflow-convention lint reads GitHub
  Actions files only.
- **A collector for the cost measures**: the measures of piece 11 are
  read from the provider's records by each repository's own scheduled job
  (the mappings name the fields); a reference collector waits until one
  has run long enough somewhere to show which fields and windows hold up.
