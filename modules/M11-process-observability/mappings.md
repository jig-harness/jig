# M11 mappings — per-ecosystem implementations

The module [invariant](README.md) — the delivery process emits typed events,
every metric declares a wired source, dashboards surface drift, and measurements
drive promote/demote — is tool-independent. This file maps its mechanisms onto
concrete telemetry/analytics backends, event emitters, and dashboard homes. The
backends below are **options**, never requirements — pick one you already run.
Replace `<placeholders>` with your values. Install the pinned Bun runtime
before the commands below; the module gates and tests require Bun.

## The two gates, per rung

| Gate | When it runs | Rung |
|------|--------------|------|
| no-dark-instruments | on any change to `metrics-registry.yaml` | [CI](../../GLOSSARY.md) (authority); cheap enough to pre-commit — a new metric cannot merge dark |
| event-schema lint | wherever an event stream is exported for aggregation (per-PR over a captured stream, or scheduled over a window) | CI; validates emitted events against `event-schema.yaml` |

The [heartbeat](#heartbeat-monitoring) is a third piece, and runs differently: a
scheduled watcher, not a gate on a change, plus a coverage check on any change
to the workflows or the cadence registry.

Both gates run on Bun (TypeScript) — any CI provider runs them. Point one
`M11` variable at wherever you vendored the module and build paths from it.

## Telemetry / analytics backends (the metric `source`)

Any of these can back a metric's `source:`; the registry stays backend-neutral
(the `source` string just names *which* wired query/event feeds the number).

| Backend kind | Examples (options) | Fits |
|--------------|--------------------|------|
| Product-analytics / event pipeline | PostHog, Amplitude, Snowplow | per-review events, adoption rate, cost-vs-catches; ad-hoc queries |
| Data warehouse | BigQuery, Snowflake, ClickHouse | joins over review + gate + tracker data; scheduled rollups feeding a parity snapshot |
| Metrics / time-series | Prometheus + Grafana, Datadog, OpenTelemetry collector | gate durations, CI-duration trend, pass-rate gauges, alerting |
| CI-native metrics | GitHub Actions job summaries / Insights, GitLab CI analytics | zero-extra-infra start: gate pass-rate and duration from the CI provider itself |

The [no-dark-instruments gate](reference/no-dark-instruments/) does not care
*which* backend — only that the `source` is a real one, not a `TODO`.

## Where events are emitted from

Process events (see [`event-schema.yaml`](templates/event-schema.yaml)) come out
of the machinery that already runs the process.

| Event | Emitted from |
|-------|--------------|
| `gate_result` | each [M1](../M1-gates-enforcement-ladder/) gate / CI step wraps its run and posts pass/fail + duration |
| `review_completed` | the review harness ([M7](../M7-pr-lifecycle-review/)) emits outcome + cost per review; a merged-PR hook records whether any review happened (adoption) |
| `cycle_time` | forge webhooks / a scheduled query over PR timestamps (opened, ready, merged, deployed) |
| `deploy_result` | the deploy + promotion workflows ([M10](../M10-environments-deploy/)) emit environment + result + duration |
| `heartbeat` | a scheduled emitter proves a pipeline is still alive; its silence is itself the signal an instrument went dark. For the heartbeat watcher, the repository's adapter emits one per watcher run from the classifier's `--json` report (the counts of red and stale jobs); see [Heartbeat monitoring](#heartbeat-monitoring) |

### GitHub Actions

```yaml
# .github/workflows/process-telemetry.yml
on:
  pull_request: { paths: ['metrics-registry.yaml', 'event-schema.yaml'] }
  schedule:
    - cron: '0 9 * * 1'          # weekly window export
jobs:
  registry:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    env: { M11: modules/M11-process-observability }
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - run: bun test "$M11"/reference/no-dark-instruments/check-metrics-wired.test.ts
      - run: bun "$M11"/reference/no-dark-instruments/check-metrics-wired.ts metrics-registry.yaml
  events:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    env: { M11: modules/M11-process-observability }
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - run: bun test "$M11"/reference/event-schema-lint/check-events.test.ts
      # export the window's events into the logfmt line shape, then validate
      - run: ./scripts/export-events > events.log     # your backend query, see below
      - run: SCHEMA=event-schema.yaml bun "$M11"/reference/event-schema-lint/check-events.ts events.log
```

### GitLab CI

```yaml
process-telemetry:
  variables: { M11: modules/M11-process-observability }
  script:
    - bun test "$M11"/reference/no-dark-instruments/check-metrics-wired.test.ts
    - bun "$M11"/reference/no-dark-instruments/check-metrics-wired.ts metrics-registry.yaml
    - bun test "$M11"/reference/event-schema-lint/check-events.test.ts
    - ./scripts/export-events > events.log
    - SCHEMA=event-schema.yaml bun "$M11"/reference/event-schema-lint/check-events.ts events.log
```

### Exporting a backend's events into the lint's line format

The [event-schema lint](reference/event-schema-lint/) reads one event per line as
whitespace-separated `key=value` tokens. Flatten your backend's records to that
with a one-liner — jq here is an export convenience, never inside the gate:

```sh
# from a JSON array of events (one object per event) to logfmt lines
jq -r '.[] | to_entries | map("\(.key)=\(.value)") | join(" ")' events.json > events.log
```

A warehouse query can emit the same shape directly (select the columns you need,
concatenate as `type=... key=...`), so the lint runs on the query output.

## Heartbeat monitoring

The [heartbeat](README.md#heartbeat-a-stopped-schedule-is-stale-never-green)
has three parts: an external monitor that pages when the watcher's report goes
missing, a collector that turns the provider's run list into the classifier's
history, and the watcher workflow that runs both and reports. It runs in a
workflow of its own, not in the telemetry workflow above: its pull-request
trigger covers different files, and its scheduled job must not sit behind a
pull-request condition.

### Monitors (the dead-man's switch)

Any monitor that expects a report on a period and raises an incident when one
is missing will do. Most accept an explicit failure report too, so a red
verdict pages at once instead of after the period runs out.

| Monitor (options) | Success report | Failure report | Raises an incident when |
|-------------------|----------------|----------------|-------------------------|
| Healthchecks.io | `GET <ping-url>` | `GET <ping-url>/fail` | no ping inside period plus grace, or a failure ping |
| Better Stack heartbeats | `GET <heartbeat-url>` | `GET <heartbeat-url>/fail` | no request inside period plus grace, or a failure request |
| Cronitor | `GET <telemetry-url>?state=complete` | `GET <telemetry-url>?state=fail` | no event on the schedule, or a fail event |
| Sentry Crons | a check-in with `status=ok` | a check-in with `status=error` | a missed or failed check-in |
| Prometheus Pushgateway | push the verdict as a gauge | push the verdict as a gauge | an alert rule on `time() - push_time_seconds` beyond the period, or on the gauge |

The watchers below use the `<url>` and `<url>/fail` form; for another monitor,
change the one reporting line.

### Collectors: the run history per provider

A collector writes the classifier's history: a JSON array of
`{"job", "id", "status", "startedAt", "finishedAt"}` (the contract is in the
[reference README](reference/heartbeat/README.md#the-two-scripts)). Collect
**only runs the schedule started**: a manual or push-triggered run of the same
workflow says nothing about whether the schedule still fires. For the same
reason, take each run's status and times from the execution the schedule
started, never from a later retry of it: a provider that lets a person re-run
an old run rewrites that run's result and finish time, so an old scheduled run
re-run by hand would make a stopped schedule fresh. Where the provider keeps
the first execution, report it; where it does not, report the run as
`cancelled`, which can never make a job fresh. Deciding that a run was never
retried takes a complete answer: a lookup that is cut off at a page, or that
fails, cannot show that no retry happened, so the collector fails instead of
reporting the run. Map every status
the provider has, and map one the table does not name to `cancelled`, so an
unknown status can never make a job fresh. Ask for enough runs per job to
reach back past `red_after` results, newest first: a collector that receives
the oldest runs instead can make a healthy job read stale or red.

| Provider | Runs of one job | `job` | `id` | `status` | `startedAt` / `finishedAt` |
|----------|-----------------|-------|------|----------|----------------------------|
| GitHub Actions | `gh api "repos/{owner}/{repo}/actions/workflows/<file>/runs?event=schedule&per_page=<n>"` | the workflow file name without its extension (what the coverage check uses) | `id` | `status` not `completed` → `running`; `conclusion` `success` → `success`; `failure`, `timed_out`, `startup_failure` → `failure`; `cancelled` → `cancelled`; `skipped` → `skipped` | `run_started_at` / `updated_at` of a completed run. A run whose `run_attempt` is above 1 was re-run by hand, and its own fields describe that latest attempt; take status and times from its first attempt (`gh api "repos/{owner}/{repo}/actions/runs/<id>/attempts/1"`) |
| GitLab CI | `GET /projects/:id/pipeline_schedules`, then `GET /projects/:id/pipeline_schedules/:schedule_id/pipelines?sort=desc&per_page=<n>` (this endpoint sorts oldest first unless told otherwise; follow pages until `<n>` runs are in hand) | the schedule's description, as the registry names it | the pipeline `id` | `success` → `success`; `failed` → `failure`; `canceled` → `cancelled`; `skipped` → `skipped`; `created`, `waiting_for_resource`, `preparing`, `pending`, `running`, `scheduled` → `running` | `started_at` / `finished_at` from `GET /projects/:id/pipelines/:pipeline_id`; a pipeline that never started (still queued, or cancelled in the queue) has no `started_at`, so use its `created_at`. A retry keeps the pipeline and overwrites its status and `finished_at`, and GitLab keeps no pipeline-level record of the first execution: the REST jobs response carries no retry flag, so ask GraphQL, which filters on the server: `project(fullPath: "<path>") { pipeline(id: "gid://gitlab/Ci::Pipeline/<id>") { jobs(retried: true, first: 1) { nodes { id } } } }`. Any node means a job was retried: report the pipeline as `cancelled` with its `created_at` as both times. An empty list is a complete answer, because the filter runs before the page is cut. A missing `pipeline` or a GraphQL error fails the collector |

A GitLab schedule lives outside the repository, so the GitLab collector is
also the coverage check: it fails, before writing any history, for an active
schedule whose description the registry does not declare, and for two
schedules that share a description. GitLab does not require descriptions to
be unique, and two schedules under one registry id would merge their histories,
so one that keeps running would hide the other one stopping. A provider not
listed here needs only the same contract.

### The watcher on GitHub Actions

```yaml
# .github/workflows/heartbeat.yml
on:
  pull_request:
    paths: ['.github/workflows/**', '.config/scheduled-jobs.yaml']
  schedule:
    - cron: '17,47 * * * *'       # every 30 minutes; declared in the registry as `heartbeat` (cadence: 30m), watcher: true
permissions: { contents: read, actions: read }
env:
  M11: modules/M11-process-observability
  REGISTRY: .config/scheduled-jobs.yaml
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - uses: oven-sh/setup-bun@<full-commit-sha> # v2
      - run: bun test "$M11"/reference/heartbeat
      - run: bun "$M11"/reference/heartbeat/check-schedules-declared.ts --registry "$REGISTRY"
  watch:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-commit-sha> # v4
      - uses: oven-sh/setup-bun@<full-commit-sha> # v2
      - name: Collect the runs of every declared job
        env: { GH_TOKEN: '${{ github.token }}' }
        run: ./scripts/collect-runs "$REGISTRY" > runs.json   # your collector: see the table above
      # Always runs, so a step that failed before it is a failure report, never silence.
      - name: Classify and report
        if: always()
        env: { MONITOR_URL: '${{ secrets.HEARTBEAT_MONITOR_URL }}', EARLIER: '${{ job.status }}' }
        shell: bash
        run: |
          status=1
          if [ "$EARLIER" = "success" ]; then
            set +e
            bun "$M11"/reference/heartbeat/classify-heartbeat.ts --registry "$REGISTRY" --history runs.json
            status=$?
            set -e
          fi
          # Both outcomes are reported; a missing report is the monitor's alarm.
          if [ "$status" -eq 0 ]; then suffix=""; else suffix="/fail"; fi
          if ! curl --fail --silent --show-error --max-time 10 --retry 2 "${MONITOR_URL}${suffix}"; then
            echo "::error::the monitor report was not delivered"
            [ "$status" -ne 0 ] || status=1
          fi
          exit "$status"
```

The `permissions:` block is the least the collector needs. The schedule
trigger fires from the default branch only. The watcher is itself a scheduled
workflow, so its registry lists it with `watcher: true`: declared, so the
coverage check passes, and not classified, since a failed watcher run would
otherwise count against the watcher on its next run and keep it red after the
cause was gone. The external monitor is what watches it. A report that cannot
be delivered fails the run even when every job is healthy, since the monitor
will page for the missing report anyway. To emit the `heartbeat` event as
well, run the classifier with `--json`, have your adapter send the counts of
red and stale jobs, and treat a failed send the same way. Pin each action to a
full commit as the [M13 conventions](../M13-pipeline-economy/README.md) say;
`<full-commit-sha>` is a placeholder here.

### The watcher on GitLab CI

```yaml
heartbeat:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule" && $HEARTBEAT == "1"'
  variables: { M11: modules/M11-process-observability, REGISTRY: .config/scheduled-jobs.yaml }
  script:
    # One block, so a failed collection is still reported as a failure.
    - |
      set +e
      ./scripts/collect-runs "$REGISTRY" > runs.json
      status=$?
      if [ "$status" -eq 0 ]; then
        bun "$M11"/reference/heartbeat/classify-heartbeat.ts --registry "$REGISTRY" --history runs.json
        status=$?
      fi
      if [ "$status" -eq 0 ]; then suffix=""; else suffix="/fail"; fi
      if ! curl --fail --silent --show-error --max-time 10 --retry 2 "${MONITOR_URL}${suffix}"; then
        echo "the monitor report was not delivered"
        [ "$status" -ne 0 ] || status=1
      fi
      exit "$status"
```

`MONITOR_URL` is a masked, protected CI/CD variable. The pipeline schedule that
runs the watcher (the one with `HEARTBEAT` set to `1`) belongs in the registry
like any other, marked `watcher: true`.

## Dashboard homes

Dashboards render from the [metrics registry](templates/metrics-registry.yaml)
(the [SSoT](../../GLOSSARY.md) for what is measured) — not from hand-built,
one-off charts that drift from it.

| Home | Fits |
|------|------|
| Grafana / Datadog board | time-series metrics: gate pass-rate, CI-duration trend, cycle time; alerting on drift |
| Product-analytics dashboard (PostHog, Amplitude) | adoption rate, cost-vs-catches, per-reviewer breakdowns |
| A generated report | a scheduled job renders the registry's metrics into a markdown/HTML summary posted to a channel — the lowest-infra dashboard |

The specific charts, thresholds, and alert values are **yours** and stay with
your repo (see the [README](README.md#left-out-by-design)); Jig ships the registry
contract and the two gates, not a particular board.

## External-precondition issue reconciliation

The [M10 reference reconciler](../M10-environments-deploy/reference/external-preconditions/)
takes a tracker port with complete open-issue listing, create, update and
close operations. Its GitHub Issues implementation uses a stable body marker,
pages through the open issues, excludes pull requests and refuses duplicates.
Grant its token Issues write only on the repository that owns the registry.
Serialize all runs that use the same marker. A complete healthy report closes
the issue; pending or unknown observations keep it open. Failed tracker reads
or writes fail the observation run. Other tracker adapters are future work.
