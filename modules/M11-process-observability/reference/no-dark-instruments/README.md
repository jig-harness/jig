# No dark instruments

The hard-won lesson this gate ports: **an instrument that is provisioned but
fail-open is worse than none.** A metric that sits on the dashboard with a
`source` that was never connected — an unset key, a `TODO` query — reads as a
real measurement while it is silently dark, so the "measure" step *looks* done
and process decisions run on a gauge that reads zero because nothing feeds it.
In the reference implementation this showed up as an adoption-rate metric left
as a `TODO` and several review-measurement keys never set: the flywheel's
[measure step](../../../M8-learning-loop/) was partly aspirational, and nobody
could see it. This gate makes "claimed but not wired" a mechanical failure.

## What it enforces

It reads a [metrics registry](../../templates/metrics-registry.yaml) and fails
if **any metric's `source` is missing, empty, or a placeholder**:

| Source value | Verdict |
|--------------|---------|
| a real wired event or query (e.g. `event:gate_result`, `query:reviews_over_merges`) | passes |
| absent, blank, or `~` / `null` | **dark** — fails the gate |
| `TODO` / `tbd` / `dark` / `none` / `fixme` (case-insensitive) | **dark** — fails the gate |

A dark instrument **fails the gate** (exit 1). A registry with no `metrics:`
collection at all is a **format error** (exit 2), kept distinct so a misspelled
key never reads as a clean, metric-free run. A present-but-empty `metrics:`
collection is a legitimate "nothing registered yet" state and passes.

The gate deliberately checks only `source` — the one field that decides whether
a number is real. A registry also carries an `owner` per metric (so a dark
instrument has someone to light it), but naming that is a registry convention,
not this low-false-positive gate's job.

## Mechanism

Portable bash + awk (no `yq` / python / jq). It parses each metric's `id` and
`source` and matches the source against the placeholder set above.

```sh
REGISTRY=metrics-registry.yaml ./check-metrics-wired.sh
```

## Where it runs

A [CI](../../../../GLOSSARY.md) gate on any change to the registry (the
authority — see [M1](../../../M1-gates-enforcement-ladder/)); cheap enough to
pre-commit. Run it as the guard that a new metric cannot merge dark: you may add
a metric to the registry, but not with an unwired source.

## Files

| File | Role |
|------|------|
| `check-metrics-wired.sh` | the gate; `REGISTRY` arg/env selects the input |
| `test-check-metrics-wired.sh` | paired self-test (exit codes + the named dark metric) |
| `fixtures/good/metrics-registry.yaml` | every source wired — must pass |
| `fixtures/empty-registry.yaml` | present-but-empty collection — must pass |
| `fixtures/bad/todo-source.yaml` | a `TODO` source — must fail |
| `fixtures/bad/empty-source.yaml` | a blank source — must fail |
| `fixtures/bad/missing-source.yaml` | no source key — must fail |
| `fixtures/bad/placeholder-variants.yaml` | mixed-case placeholders — must fail |
| `fixtures/bad/no-metrics-key.yaml` | no `metrics:` collection — must error |

Run the self-test with `./test-check-metrics-wired.sh`.
