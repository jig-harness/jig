# Heartbeat: a job that stopped running is stale, never green

Part of [M11 Process observability](../../README.md).

A scheduled job that stops running keeps showing its last result. The
workflow that was disabled, the schedule that a provider paused after a quiet
period, the trigger that was edited out: each leaves a last run behind, and
that run is usually green. A dashboard that reads "latest conclusion" says
healthy for weeks about something that has not run since the spring. Jobs that
fail loudly get fixed; jobs that stop quietly are found by accident.

So the question is asked of the clock as well as of the outcome. Every
scheduled job declares the cadence it is expected to produce a result at, and
the classifier compares that with the job's recent runs.

## The classes

| Class | Means | The watcher |
|-------|-------|-------------|
| `green` | The last result is a success and inside the cadence plus grace | passes |
| `degraded` | The last results are failures, but fewer in a row than the job's `red_after` | passes, and the report says so |
| `red` | `red_after` or more failures in a row | fails |
| `stale` | No result inside the cadence plus grace: the job stopped, was disabled, only ever got cancelled, hung, or has never run | fails |
| `running` | A run is in progress and the job would otherwise be green or degraded | passes |

Stale is never green. A job that is both failing and overdue is `red`, the
more specific fact. A run in progress never excuses an overdue job, and never
hides a red one. A job with no result yet counts as running only while its
first run is younger than the cadence plus grace, so a run stuck in a queue
becomes stale.

## What counts as a result

- A **success** or a **failure** is a result. A provider's timed-out run is a
  failure.
- A **cancelled** or **skipped** run produced no result: it is neither a
  success nor a failure, and it neither ends a streak of failures nor makes the
  job fresh. A job whose every run is cancelled (a superseded-run rule too
  eager, a concurrency group that always loses) is stale.
- A run **still going** counts as running only for `max_run`. Past it the run
  is hung and counts as no run, so a stuck job cannot read as "in progress"
  forever.
- A job the registry declares and the history never mentions has produced no
  result: stale. An **empty history is therefore every job stale**, which is
  what a collection that failed silently should look like.
- A history that is not valid, that holds a time more than five minutes ahead
  of the watcher's clock (a runner clock further ahead would make a stopped job
  look fresh) or a date that does not exist, or that lists one run twice (it
  would count one failure twice), is an input error, never a pass. The five
  minutes absorb ordinary clock skew between a runner and the watcher.
- A success and a failure that finish at the same instant are ordered failure
  first, so the class never depends on the order the collector wrote them in.

## The two scripts

`classify-heartbeat.ts` reads the cadence registry
([`templates/scheduled-jobs.yaml`](../../templates/scheduled-jobs.yaml)) and a
run history, and prints a class per job:

```bash
bun classify-heartbeat.ts --registry .config/scheduled-jobs.yaml --history runs.json [--now <time>] [--json]
```

- `--registry` — the cadence registry: an optional `version: 1` and `jobs:`,
  each with an `id`, a `cadence`
  (`30m`, `12h`, `7d`), and optionally `grace` (default a quarter of the
  cadence), `max_run` (default `6h`), `red_after` (default `1`) and `watcher` (the job
  that runs the classifier: declared, not classified, because its own failed
  run would keep it red after the cause is gone; the external monitor watches
  it), and an optional text `description`. An unknown
  field, a field of another shape, a duplicate id, an empty list or a duration it cannot read is an
  error.
- `--history` — a JSON array of runs collected from the CI provider
  (`-` for standard input; the collectors are in [mappings.md](../../mappings.md)):
  `{"job", "id", "status", "startedAt", "finishedAt"}`, where `id` is the
  provider's run identifier (text or a whole number, unique per job), `status` is
  `success`, `failure`, `running`, `cancelled` or `skipped`, and times are
  written like `2026-03-10T12:00:00Z`, with `Z` or a UTC offset. Runs of a job the registry does not declare
  are listed and ignored.
- `--now` — the clock, for a test or a replay; the current time by default.
- `--json` — the report as JSON: `now`, `verdict` (`ok` or `red`), `jobs`
  (each with its class, reason, consecutive failures, last result and age) and
  `undeclared`.

`check-schedules-declared.ts` is the coverage half. A classifier can only call
a job stale if the registry names it, so a scheduled workflow missing from the
registry is a job nobody watches:

```bash
bun check-schedules-declared.ts --registry .config/scheduled-jobs.yaml [--workflows .github/workflows]
```

It lists the workflows with a `schedule:` trigger (their id is the file name
without the extension) and fails for each one the registry does not declare.
Two scheduled files that share an id (`nightly.yml` and `nightly.yaml`) are
an input error: one registry entry would cover both, so fresh runs of one
would hide the other stopping.
This is the GitHub Actions form; a provider that keeps its schedules outside
the repository compares its own schedule list with the registry in the
collector instead ([mappings.md](../../mappings.md)).

Both import `lib/` from the Jig repository, so run them from a pinned Jig
checkout or vendor `lib/` beside them.

## Exit codes

| Code | `classify-heartbeat.ts` | `check-schedules-declared.ts` |
|------|-------------------------|-------------------------------|
| 0 | every job is green, degraded or running | every scheduled workflow is declared (or none is scheduled) |
| 1 | a job is red or stale | a scheduled workflow is not declared |
| 2 | usage or input error | usage or input error, including a workflow file that does not parse and two scheduled workflows with one id |

The classifier's exit status is the whole contract with the watcher workflow:
it exits 0 when nothing needs a person and 1 when something does, and the
watcher reports that to the external monitor (the dead-man's switch in the
[module README](../../README.md#heartbeat-a-stopped-schedule-is-stale-never-green)).

## Files

| File | Role |
|------|------|
| `classify-heartbeat.ts` | the classifier; `--registry`, `--history`, `--now` and `--json` |
| `classify-heartbeat.test.ts` | paired self-test: the classes, their boundaries, the input errors |
| `check-schedules-declared.ts` | the coverage check |
| `check-schedules-declared.test.ts` | paired self-test |
| `fixtures/registry.yaml` | three jobs with different cadences, graces and thresholds |
| `fixtures/good/healthy.json` | every job inside its cadence — must pass |
| `fixtures/good/degraded.json` | one failure below the job's threshold — must pass, as degraded |
| `fixtures/good/running.json` | a run in progress — must pass, as running |
| `fixtures/good/undeclared-job.json` | a run of a job the registry lacks — ignored, must pass |
| `fixtures/bad/stale-last-green.json` | a job whose last run was green but is days old — must fail, as stale |
| `fixtures/bad/red.json` | two failures in a row at `red_after: 2` — must fail, as red |
| `fixtures/bad/never-ran.json` | a declared job with no run — must fail, as stale |
| `fixtures/bad/only-cancelled.json` | the latest runs are cancelled or skipped, so the last result is old — must fail, as stale |
| `fixtures/bad/all-cancelled.json` | every run of one job is cancelled or skipped — must fail, as stale |
| `fixtures/registry-watcher.yaml`, `fixtures/good/watcher-failed.json` | a declared watcher whose own runs failed — must pass, not classified |
| `fixtures/bad/empty-history.json` | no runs at all — must fail, every job stale |
| `fixtures/bad/duplicate-run.json` | one run listed twice — must exit 2 |
| `fixtures/bad/` (the other files) | malformed histories and registries, including an impossible date and a cancelled or skipped run with a bad finish time — must exit 2 |
| `fixtures/workflows-good/`, `workflows-bad/`, `workflows-broken/` | the coverage check's inputs: all declared, one undeclared, one that does not parse |

Run the self-tests with `bun test .`.
