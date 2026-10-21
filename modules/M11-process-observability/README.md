# M11 — Process observability

**What problem this solves.** Teams instrument their *product* obsessively —
funnels, error rates, latency — and their *process* not at all. Nobody can say
what share of pull requests ([PRs](../../GLOSSARY.md)) actually get reviewed,
whether a gate passes 100% of the time (theater) or fails constantly (noise),
whether [CI](../../GLOSSARY.md) is quietly getting slower, or what the automated
reviewer costs against what it catches. So decisions about the delivery process
— promote this gate to blocking, keep paying for that reviewer, trust this
number — run on vibes. Worse, teams that *do* provision instruments often leave
them **fail-open**: a metric on the dashboard whose data source was never wired,
a key never set, a `TODO` where a query should be. That is not a half-measure —
it reads as a real measurement while it is silently dark, so the "measure" step
looks done and the decision runs on a gauge that reads zero because nothing
feeds it. This module instruments the delivery system itself, and makes
"claimed but not wired" a mechanical failure.

The same silence has a second form that no dashboard shows: **scheduled
automation that has stopped running.** A nightly run, a verification
watchdog, a weekly audit: each keeps displaying its last result after the
schedule is disabled, paused by the provider or edited out, and that last
result is usually green. A job that fails loudly gets fixed; a job that stops
quietly is found by accident, days later, by the failure it was there to
catch. This module also watches whether the schedules are still running, not
only how they last finished.

## Invariant

> The delivery process **emits telemetry** — review outcomes and their cost,
> gate results and their duration, cycle times — as a **closed set of typed
> events**. Every process metric declares a **wired source**: an instrument
> that is provisioned but dark (fail-open, `TODO`, unset) is treated as worse
> than absent and fails a gate. Dashboards make process **drift visible**, and
> **measurements drive promote/demote decisions** for gates and review
> [lenses](../../GLOSSARY.md) — a promotion must cite a recorded measurement
> from a **provably live** instrument before autonomy increases.

> Every **scheduled job** declares the **cadence** it is expected to produce a
> result at. A job whose latest result is older than that cadence plus a
> grace, or that has produced none, is **stale** (unless its failures in a
> row already make it **red**, the more specific fact), and **stale is never
> green**: a job is exactly one of green, degraded, red, stale or running.
> The watcher reports to an **external monitor** on a success and on a
> failure, so if the watcher itself stops, the missing report raises the
> incident (a **dead-man's switch**). How many failures in a row make a job
> red is configured per job.

> External-precondition failures reconcile one current issue per registry;
> a complete healthy observation closes it automatically.

> A scheduled check reports each distinct cause as **one issue**, identified by
> a stable [cause fingerprint](../../GLOSSARY.md). Recurrences update that issue;
> confirmed recovery closes it. A [flood breaker](../../GLOSSARY.md) for each
> cause announces when it suppresses repeated comments after **N consecutive
> failures**, and re-arms only on genuine recovery. The test job produces
> evidence only; a separate triage step classifies and reconciles issues.

Everything below applies these tool-independent statements;
concrete per-backend wiring lives in [mappings.md](mappings.md).

## One current issue for external preconditions

An external precondition that fails every day needs one current issue, not
one issue per run. A [reconciler](../../GLOSSARY.md) compares a complete
observation with the tracker's current state: it opens the registry's issue
when anything fails, updates it with the current failing entries, and closes
it automatically only after every entry passes or has a valid, visible
waiver. Pending checks and failed reads keep it open. Each entry names its
owner and recovery action; the report does not contain secret values.

Use a stable machine marker rather than a title search, read every page of
open issues, and serialize observations that write the same marker. A marker
anyone can type is an identifier, not ownership: consider only issues the
reconciling identity opened. If a
lookup fails or duplicate open issues carry the marker, fail without writing
or closing anything. An invalid registry is an observation failure, never an
empty green report. Tracker failures fail the run as well: checking without
maintaining the issue leaves the operational work invisible.

The [M10 reference](../M10-environments-deploy/reference/external-preconditions/)
provides the external-registry reconciler behind a tracker interface, with a
GitHub Issues adapter. The checks remain read-only against the systems they
inspect; tracker reconciliation is the explicit write boundary. The
[heartbeat](#invariant) still watches whether the scheduled observation ran.

## Core pieces

1. **Typed process events** — the process emits a closed set of event types
   (review outcome + cost, gate pass/fail + duration, cycle times, deploy
   results), declared once in [`templates/event-schema.yaml`](templates/event-schema.yaml)
   and validated by the [event-schema lint](reference/event-schema-lint/) so a
   typo'd type or a missing required field can't quietly corrupt a metric. This
   measures the **delivery process, not the product**.
2. **A metric registry with no dark instruments** — every process metric lives
   in [`templates/metrics-registry.yaml`](templates/metrics-registry.yaml) with
   a **wired `source`** and an **owner**. The [no-dark-instruments gate](reference/no-dark-instruments/)
   fails the build if any source is missing, empty, or a placeholder, because
   a silently-dark instrument makes the "measure" step aspirational.
3. **Parity measurement — reused from [M8](../M8-learning-loop/), not
   duplicated.** *What* a reviewer's recall/precision/`missed_blockers` numbers
   mean and how they gate promotion is [M8](../M8-learning-loop/)'s
   [parity report](../M8-learning-loop/reference/parity-report/). M11 owns the
   other half: the **telemetry emission** those numbers are computed from, the
   **registry** they are declared in, and the **no-dark-instruments** discipline
   that keeps them honest.
4. **Dashboards that make drift visible** — metrics roll up from the events into
   dashboards whose job is to surface an adoption rate sliding, a gate's
   pass-rate collapsing, or cycle time creeping up, early enough to act. The
   registry is the single source of truth ([SSoT](../../GLOSSARY.md)) for what
   is measured; dashboards render from it.
5. **Measurements drive promote/demote** — a gate goes advisory→blocking, or a
   reviewer/lens comment-only→blocking, only on a recorded measurement that
   clears [M7](../M7-pr-lifecycle-review/)'s precision bar — and only if the
   instrument behind that measurement is provably live. Demotion (step back to
   advisory, fix the instrument) needs no such ceremony. Trust is
   one-directional: real measurement before more autonomy.

6. **A heartbeat for scheduled automation** — see the next section. A
   [cadence registry](templates/scheduled-jobs.yaml) names every scheduled job
   and how often it must produce a result; the
   [heartbeat classifier](reference/heartbeat/) puts each job in a class from
   its run history; an external monitor notices when the watcher itself goes
   quiet.

The model as a copyable narrative is [`templates/TELEMETRY.md`](templates/TELEMETRY.md).

## Merge conflicts: share and coverage

Parallel work's conflict rate measures pull requests, rather than how many
paths or repeated resolutions one pull request produced. The
[`merge_conflict` event](templates/event-schema.yaml) names the operation,
path and cause; when available it also carries the concluding commit, pull
request, decision, reason, regions, elapsed time and source. Replay and live
evidence of the same concluding commit and path are one conflict.
[`resolve-conflicts`](../../plugin/skills/resolve-conflicts/SKILL.md) keeps
the local live record; a repository's emitter can send those events to its
own event pipeline. The local record is only this clone's evidence, and a
cause that could not be derived stays unknown.

The [metric registry](templates/metrics-registry.yaml)'s
`merge-conflict-share` uses the forge's merged pull requests over the
scoreboard's window as its cohort. A pull request is conflicted when a
replayed or live record names it. It is observed clean only when replay
reaches its head without a conflict and the forge records no force-push;
a force-push can hide a rebase's conflicts. All others are unknown. Silence
in the live record never proves a clean pull request. Cherry-picks and
reverts resolved in other clones can remain invisible to both sources.

Report conflicted over conflicted plus observed-clean pull requests, with
coverage as that measured population over the whole cohort. Also bound the
whole-cohort share by counting unknown pull requests first clean, then
conflicted. Withhold the verdict below the configured coverage floor or
when those bounds reach different verdicts against the baseline. A small
unobserved part of the cohort must not decide whether a change helped.
The same bound rule applies to late-round and self-inflicted shares on
incomplete populations.

The [`drive-pr` scoreboard](../../plugin/skills/drive-pr/README.md) is the
runnable form; [M12](../M12-parallel-agent-ergonomics/README.md) owns the
practice of acting on recurring conflict paths.

## Heartbeat: a stopped schedule is stale, never green

A disabled workflow keeps its last green run. So "how did it last finish?" is
the wrong only question: the other is "when did it last finish?", asked of the
clock.

**The cadence registry.** Every scheduled job is listed in one file with the
interval it must produce a result at, a grace for the lateness a provider
adds (it starts scheduled runs late under load and sometimes drops one), and
the number of failures in a row that make it red. The job that runs the
classifier is listed too, marked as the watcher, and left out of the
classification: the external monitor is what watches it. One list is the single
source of truth for what is watched. A check fails a scheduled workflow that
is missing from it, so a new schedule cannot arrive unwatched: that is the
dark instrument the registry's own gate refuses, one level up.

**The classes.** From the registry, the job's recent runs and the time now,
the [classifier](reference/heartbeat/) puts each job in exactly one:

| Class | Means |
|-------|-------|
| green | the last result is a success, inside the cadence plus grace |
| degraded | recent failures, fewer in a row than the job's red threshold |
| red | at least the job's threshold of failures in a row |
| stale | no result inside the cadence plus grace, or never one |
| running | a run is in progress, and the job is otherwise green or degraded |

These rules keep the classes honest:

1. **Stale is a failure of the watcher's verdict.** A watcher exits non-zero
   for red and for stale alike. "It stopped" and "it failed" both need a
   person, and only one of them used to show.
2. **Only a success or a failure is a result.** A cancelled or skipped run says
   nothing about whether the job works; it neither makes the job fresh nor
   ends a streak of failures. A job whose every run is cancelled is stale.
3. **A run in progress is bounded.** It counts as running for a declared
   maximum; past it the run is hung and counts as no run. A job that has never
   produced a result is running only while its first run is younger than the
   cadence plus grace. It never excuses an
   overdue job and never hides a red one.
4. **Missing evidence reads as stale.** A declared job with no run in the
   history is stale, and so is every job when the history is empty, because an
   empty history is what a collection that failed silently leaves behind. A
   history the classifier cannot trust (not valid, a time more than five
   minutes ahead of the watcher's clock) is an error, never a pass.

**The dead-man's switch.** The watcher is itself a scheduled job, and nothing
inside the repository can notice that it has stopped. So it reports its
verdict to a monitor *outside* the system it watches, on **both** outcomes: a
success report when every job is green, degraded or running, a failure report
when any is red or stale. The monitor expects a report every cadence and
raises an incident when none arrives. Silence is then a signal in its own
right: the watcher stopped, the schedule that runs it was disabled, the runner
pool is down, or the provider is. Reporting only on failure would make a dead
watcher indistinguishable from a healthy quiet one. The monitor products that
do this, and the watcher workflow, are in [mappings.md](mappings.md#heartbeat-monitoring).

**Thresholds per job.** How many consecutive failures make a job red is the
job's own setting, because a flaky external check and a deploy verification
should not page at the same count. The value is the repository's; the rule is
that a threshold can only be raised in the registry, in review, never in the
watcher, so a job cannot be quietened by tuning the thing that watches it.

Tie-ins: [M10](../M10-environments-deploy/README.md)'s verified-pointer
watchdog is one scheduled job this registry should list, and the heartbeat is
what notices if the watchdog itself stops; [M13](../M13-pipeline-economy/README.md)'s
queue-stall check covers a run that never started, this covers a schedule
that never fired.

## Scheduled failures: one issue per cause

A nightly failure can disappear in a log nobody reads. Filing a fresh issue
for every run solves visibility by creating a second problem: one outage
buries unrelated findings under repeated tickets. Keep one issue per cause,
with bounded updates and an explicit recovery signal.

**Separate evidence from triage.** The test job writes results and the scope
it actually checked; it never calls a tracker or a model. A separate triage
step reads that evidence and classifies each finding before reporting it:

| Classification | Meaning | What the issue records |
| --- | --- | --- |
| regression | behaviour previously supported now fails | the broken expectation and evidence of the change |
| intended change | the expectation no longer matches an approved behaviour change | the decision and the expectation to update |
| flake | equivalent executions disagree without an intended behaviour change | the inconsistent results and the reliability work owed |
| environment | an external dependency or execution environment prevented the check | the failed prerequisite and its owner |

A successful retry alone does not prove a flake, and missing evidence does
not justify guessing a classification. Inconclusive triage fails visibly and
leaves existing issues open until evidence supports a decision. All classes
retain an owner and evidence; none turns the test job's failure into a pass.

**Stable identity.** A cause fingerprint uses the repository, relevant check
or shared prerequisite, affected scope (such as an environment), and a
normalized failure signature. It excludes run identifiers, timestamps and
other changing log details. Runs showing the same cause find the same issue;
independent causes get separate issues. Several checks that establish the
same failed prerequisite can share its cause, with their evidence attached.
Keep the fingerprint on the issue and compare it exactly after searching;
a similar title is not identity. A recurrence comments on the existing issue
with its classification and evidence, rather than filing another. A cause
that returns after recovery reopens that same issue.

**Recovery requires a check.** Close an issue automatically only when a later,
complete result actually exercises its affected scope and confirms that the
cause is absent. A skipped, cancelled, missing, partial or failed collection
is unknown, not recovered. Nor does a green result from an unrelated check
close it. Another cause blocking the affected check leaves the earlier cause
unknown. Record the recovery evidence when closing. This complements the
[heartbeat](#heartbeat-a-stopped-schedule-is-stale-never-green): a schedule
that stopped cannot close its own failure issues through silence.

**Announced flood breaker.** Choose and review a positive threshold N for
consecutive failed observations of each cause. The first failure opens or
reopens its issue; subsequent failures comment until the Nth failure, whose
update announces that further recurrence comments are suppressed, why, and
what recovery will re-arm reporting. For N = 1 the opening or reopening
notice includes the announcement. While suppressed, keep collecting evidence
and recording the cause's latest observation and count in durable state;
leave the issue open. Suppression changes notification volume, never the
check's verdict or whether other causes report. Unknown observations neither
advance nor reset the streak. A confirmed recovery posts its evidence, closes
the issue and clears the streak and suppression; the next failure reports
again. Restarting the triage process, waiting a period, or a person closing
an issue does not constitute recovery or reset the breaker.

Reporting must survive retries and overlapping runs: processing the same
observation twice neither duplicates a comment nor advances the streak, and
an old result cannot close an issue after a newer failure. Serialize changes
for each cause and retain durable progress across restarts. A tracker error
fails triage visibly; it never becomes an empty finding list or a recovery.
The [tracker mappings](mappings.md#scheduled-failure-issues) describe how a
repository can implement this practice today. Jig's reusable [reconciler](../../GLOSSARY.md) is
[future work](../../design/scheduled-failure-reconciliation.md).

## Maturity levels

- **Lite** — the process events you care about are **named and documented**
  ([`TELEMETRY.md`](templates/TELEMETRY.md) + [`event-schema.yaml`](templates/event-schema.yaml)),
  and **at least one is actually emitted** (start with gate results — you
  already run gates). Enforcement may be convention.
- **Standard** — a **metrics registry** exists with wired sources and the
  [no-dark-instruments check](reference/no-dark-instruments/) runs
  (mechanical); **review outcomes and gate results are emitted as events**
  validated by the [event-schema lint](reference/event-schema-lint/);
  **every scheduled job is in the [cadence registry](templates/scheduled-jobs.yaml)
  and a scheduled watcher classifies its runs**, failing for a job that is
  stale or red (mechanical); **each external-precondition registry
  [reconciles one current issue](#one-current-issue-for-external-preconditions)**
  that closes only after a complete healthy observation (mechanical); and
  scheduled failures have evidence-only test jobs and separate triage that
  maintains one issue per cause, with confirmed recovery and an announced
  per-cause flood breaker (mechanical).
- **Strict** — both gates run in [CI](../../GLOSSARY.md) with their self-tests
  (mechanical); **the watcher reports to an external monitor on success and
  on failure**, so a watcher that stops is itself an incident;
  **reviewer/lens promotion decisions cite recorded measurements**
  (ties to [M7](../M7-pr-lifecycle-review/) / [M8](../M8-learning-loop/)); and
  dashboards for **gate pass-rate, review-adoption, and cost** exist and are
  reviewed on a cadence.

## Adoption steps

1. Copy [`TELEMETRY.md`](templates/TELEMETRY.md) and
   [`event-schema.yaml`](templates/event-schema.yaml); prune the event set to
   what you emit, and wire one emitter for real — `gate_result` is the cheapest
   start (the [M1](../M1-gates-enforcement-ladder/) gates already produce the
   pass/fail).
2. Start a [`metrics-registry.yaml`](templates/metrics-registry.yaml): register
   only metrics you will actually watch, each with a **wired** source and an
   owner.
3. Add the [no-dark-instruments gate](reference/no-dark-instruments/) so a
   metric can never merge with an unwired source, and the
   [event-schema lint](reference/event-schema-lint/) so emitted events can't
   drift from the schema.
4. Build dashboards from the registry (recipes per backend in
   [mappings.md](mappings.md)); review them on a cadence.
5. List every scheduled job in a
   [`scheduled-jobs.yaml`](templates/scheduled-jobs.yaml) with the cadence you
   expect, add the [coverage check](reference/heartbeat/) so a new schedule
   cannot arrive unlisted, and run the
   [heartbeat classifier](reference/heartbeat/) on a schedule of its own over
   the provider's run history ([collectors per provider](mappings.md#heartbeat-monitoring)).
   Make it fail on red and on stale.
6. Have the watcher report to an external monitor on both outcomes, and have
   the monitor page when a report is missing.
7. Separate scheduled-check evidence collection from triage. Adopt the
   [issue lifecycle above](#scheduled-failures-one-issue-per-cause), choose N
   per cause policy, and verify recurrence, suppression, recovery, unknown
   evidence, concurrent runs and replay before enabling tracker writes.
8. Gate every promote decision in [M7](../M7-pr-lifecycle-review/) /
   [M8](../M8-learning-loop/) on a measurement from a **live** instrument —
   never a dark one.

## Status

### Runnable form

Jig's [`drive-pr`](../../plugin/skills/drive-pr/README.md) skill measures
the review process it runs, as scripts a repository can call on its own:

| Script | What it measures |
|--------|------------------|
| `loop-metrics.ts` | One pull request's review-loop cost: rounds, threads, the outcome mix, and how much of the final change landed after review began. A drive prints it when it stops |
| `defect-escape.ts` | Whether findings the loop declined to fix (`wont-fix`, `deferred`) came back as defects |
| `fractal-metrics.ts` | The cross-PR scoreboard: review figures and merged-PR conflict share with coverage over a window, each judged against a recorded baseline whose source document must still contain it, so a stale baseline is caught |
| `fleet-health.ts` | Ceremony against progress: review rounds and follow-ups weighed against merged product work, with the thresholds in the repository's own fleet-health file. Beside the stalled-epic signal it keeps an [epic census](../../GLOSSARY.md): started epics that are finished but still open, blocked on a last child or two, or owned by nobody. The census is read-only, feeds the closure step, and repeats that closing needs an acceptance verdict |

Their configuration is `fleet_health` and `drive.escape_baseline_doc` in the
[configuration reference](../../plugin/CONFIGURATION.md#fleet_health).

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/TELEMETRY.md`](templates/TELEMETRY.md) | The copyable model: events → metrics → promote/demote, linked to [M7](../M7-pr-lifecycle-review/)'s precision bar and [M8](../M8-learning-loop/)'s measure step |
| [`templates/event-schema.yaml`](templates/event-schema.yaml) | A generic schema of typed process events |
| [`templates/metrics-registry.yaml`](templates/metrics-registry.yaml) | The registry of process metrics, each with a wired source and an owner |
| [`reference/event-schema-lint/`](reference/event-schema-lint/) | Validates an emitted event stream against the schema |
| [`reference/no-dark-instruments/`](reference/no-dark-instruments/) | Fails when a registered metric's source is missing, empty or a placeholder |
| [`templates/scheduled-jobs.yaml`](templates/scheduled-jobs.yaml) | The cadence registry: every scheduled job, how often it must produce a result, its grace and its red threshold |
| [`reference/heartbeat/`](reference/heartbeat/) | The classifier (green, degraded, red, stale, running, over a run history and the registry) and the coverage check (a scheduled workflow missing from the registry fails) |
| [`mappings.md`](mappings.md) | Telemetry and analytics backends, where events are emitted from, dashboard homes |
| [maturity criteria](../../plugin/skills/audit/criteria/M11-process-observability.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Jig declares its own scheduled workflow in `.config/scheduled-jobs.yaml` and
runs the coverage check in its gates. It does not yet run the watcher: that
needs a monitor account, which is a person's decision, so the watcher and its
dead-man's switch are described and tested here but not yet switched on for
Jig itself.

Each reference gate is a standalone Bun script with a self-test and fixtures.
The parity and precision computation is not repeated here: it is
[M8](../M8-learning-loop/)'s [parity report](../M8-learning-loop/reference/parity-report/),
and M11 owns the emission, registry and dashboard side.

### Left out by design

- **A dashboard product and threshold values.** The specific charts, layout,
  backend wiring, metric thresholds and alert values belong to each
  repository. The module provides the mechanism (typed events, a wired
  registry, the two gates) and the decision rules, not the numbers or a
  particular vendor's dashboard.
- **A monitor product, and the cadences.** Which external monitor receives the
  watcher's reports, and which jobs run how often, are the repository's.
  [mappings.md](mappings.md#heartbeat-monitoring) lists the products that
  support the pattern; the module requires only a monitor that raises an
  incident when an expected report does not arrive.
- **Automatic repair.** The heartbeat says a job is stale or red and does not
  restart or repair it. External-precondition findings and scheduled-failure
  triage maintain tracker issues for people to act on, but never repair the
  inspected system; classification does not approve a changed expectation.
- **A required backend.** Telemetry backends (product-analytics tools, data
  warehouses, CI-native metrics) appear only as options in
  [mappings.md](mappings.md).
- **CI time and cost.** Measuring what each workflow and job costs, so a
  decision about what runs where cites a number, is
  [M13 pipeline economy](../M13-pipeline-economy/README.md)'s Strict level.

### Future

A reusable scheduled-failure reconciler on the existing tracker interface is
[designed](../../design/scheduled-failure-reconciliation.md), but not shipped.
The doctrine and tracker mappings above are adoptable with a repository's own
triage; no new runtime configuration or tracker-writing command is provided.
