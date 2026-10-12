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

## Invariant

> The delivery process **emits telemetry** — review outcomes and their cost,
> gate results and their duration, cycle times — as a **closed set of typed
> events**. Every process metric declares a **wired source**: an instrument
> that is provisioned but dark (fail-open, `TODO`, unset) is treated as worse
> than absent and fails a gate. Dashboards make process **drift visible**, and
> **measurements drive promote/demote decisions** for gates and review
> [lenses](../../GLOSSARY.md) — a promotion must cite a recorded measurement
> from a **provably live** instrument before autonomy increases.

Everything below is that one tool-independent statement made mechanical;
concrete per-backend wiring lives in [mappings.md](mappings.md).

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

The model as a copyable narrative is [`templates/TELEMETRY.md`](templates/TELEMETRY.md).

## Maturity levels

- **Lite** — the process events you care about are **named and documented**
  ([`TELEMETRY.md`](templates/TELEMETRY.md) + [`event-schema.yaml`](templates/event-schema.yaml)),
  and **at least one is actually emitted** (start with gate results — you
  already run gates). Enforcement may be convention.
- **Standard** — a **metrics registry** exists with wired sources and the
  [no-dark-instruments check](reference/no-dark-instruments/) runs
  (mechanical); **review outcomes and gate results are emitted as events**
  validated by the [event-schema lint](reference/event-schema-lint/).
- **Strict** — both gates run in [CI](../../GLOSSARY.md) with their self-tests
  (mechanical); **reviewer/lens promotion decisions cite recorded measurements**
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
5. Gate every promote decision in [M7](../M7-pr-lifecycle-review/) /
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
| `fractal-metrics.ts` | The cross-PR scoreboard: those figures over a window, each judged against a recorded baseline whose source document must still contain it, so a stale baseline is caught |
| `fleet-health.ts` | Ceremony against progress: review rounds and follow-ups weighed against merged product work, with the thresholds in the repository's own fleet-health file |

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
| [`mappings.md`](mappings.md) | Telemetry and analytics backends, where events are emitted from, dashboard homes |
| [maturity criteria](../../plugin/skills/audit/criteria/M11-process-observability.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

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
- **A required backend.** Telemetry backends (product-analytics tools, data
  warehouses, CI-native metrics) appear only as options in
  [mappings.md](mappings.md).
