# TEMPLATE — Process observability model

> Copy this into your docs tree (e.g. `docs/development/telemetry.md`) and adapt
> the event names, metrics, and owners to your repo. It is the narrative
> contract; the machine-checkable pieces are `event-schema.yaml`,
> `metrics-registry.yaml`, and the two gates under
> [`../reference/`](../reference/).

This describes how the **delivery process measures itself** — not the product.
The product has its own analytics; this is the instrumentation of *how work
gets shipped*: what review costs and catches, whether gates pass, how long the
loop takes. The point is to replace "process on vibes" with process on numbers,
and to keep those numbers honest.

## The standing rule: no dark instruments

> An instrument that is provisioned but fail-open — a metric whose source was
> never wired, a key never set, a `TODO` where a query should be — is **worse
> than none.** It reads as a real measurement while it is silently dark, so the
> "measure" step looks done and decisions run on a gauge that reads zero
> because nothing feeds it.

Measurement must be **real before autonomy increases.** You do not promote a
gate to blocking, or a reviewer from comment-only to blocking, on a number you
cannot show is live. Every metric declares a wired `source`; the
[no-dark-instruments gate](../reference/no-dark-instruments/) fails the build if
one is dark. Provision the instrument and confirm it emits *before* you lean on
what it says.

## What the process emits (events)

Process events are a **closed set** declared in
[`event-schema.yaml`](event-schema.yaml) and validated by the
[event-schema lint](../reference/event-schema-lint/). The starting set:

| Event | Emitted when | Carries (required) |
|-------|--------------|--------------------|
| `review_completed` | a reviewer finishes a PR | reviewer, outcome, findings, **cost** |
| `gate_result` | a quality gate runs | gate, result (pass/fail), duration |
| `cycle_time` | a PR crosses a lifecycle stage | stage, elapsed time |
| `deploy_result` | a deploy/promotion runs | environment, result, duration |
| `heartbeat` | an emitter proves it is still alive | emitter id (its silence is a signal) |

Two of these are owned elsewhere and *referenced* here: `gate_result` is the
[M1](../../M1-gates-enforcement-ladder/) gate ladder's output made into an
event, and `deploy_result` sources from [M10](../../M10-environments-deploy/).
M11 owns the emission discipline and the schema they must satisfy.

## How events roll up (metrics + dashboards)

Metrics are registered in [`metrics-registry.yaml`](metrics-registry.yaml), each
naming its wired `source` and an `owner`. Dashboards render from the registry —
so "what do we measure about ourselves" has one answer, not a scatter of
hand-built charts.

| Metric | Rolls up from | Makes visible |
|--------|---------------|---------------|
| review-adoption-rate | `review_completed` over merges | is the review process actually used |
| reviewer-cost-vs-catches | `review_completed` cost vs confirmed findings | is a reviewer worth its cost |
| gate-pass-rate | `gate_result` | a gate that always fails (noise) or never fails (theater) |
| ci-duration-trend | `gate_result` duration | CI slowdown before it taxes every PR |
| cycle-time (per stage) | `cycle_time` | where the delivery loop stalls |

A dashboard's job is to make **drift visible** — an adoption rate sliding, a
gate’s pass-rate collapsing, cycle time creeping up — early enough to act. The
specific threshold/alert *values* are yours; groundwork ships the mechanism, not
the numbers.

## How measurements drive promote/demote

Measurement is not a report you file — it decides posture. This is the shared
seam with [M8](../../M8-learning-loop/) (which owns the parity/precision
*computation*) and [M7](../../M7-pr-lifecycle-review/) (whose
**precision bar** is the promotion rule for reviewers and lenses):

| Signal (measured) | Decision |
|-------------------|----------|
| a reviewer/lens clears the [precision bar](../../M7-pr-lifecycle-review/) on recorded data | **promote** comment-only → blocking |
| a reviewer misses a blocker an oracle caught (M8 parity) | **do not promote** / open a lever; keep the oracle |
| a gate’s pass-rate shows it is settled and its findings are real | **promote** advisory → blocking |
| a gate is constant noise, or a metric goes dark | **demote** / fix the instrument before trusting it |

The rule is one-directional about trust: **a promotion must cite a recorded
measurement, and the instrument behind it must be provably live** (the
no-dark-instruments gate is what makes "provably" mechanical). A demotion needs
no such ceremony — you may always step back to advisory.

## Adopt

1. Copy [`event-schema.yaml`](event-schema.yaml); prune to the events you emit,
   and emit at least one for real (start with `gate_result` — you already run
   gates).
2. Copy [`metrics-registry.yaml`](metrics-registry.yaml); register the metrics
   you will actually watch, each with a **wired** source and an owner.
3. Wire the [no-dark-instruments gate](../reference/no-dark-instruments/) and
   the [event-schema lint](../reference/event-schema-lint/) into CI.
4. Build the dashboards from the registry; review them on a cadence.
5. Gate every promote decision (in M7/M8) on a measurement from a live
   instrument — never a dark one.
