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
| `heartbeat` | a scheduled emitter proves a pipeline is still alive; its silence is itself the signal an instrument went dark |

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
