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
collection at all, or one whose content is not a block list of `- ` items (a
bare mapping, or a stray key between or after items), is a **format error** (exit 2), kept distinct so a
misspelled key or a malformed block never reads as a clean, metric-free run. A present-but-empty `metrics:`
collection is a legitimate "nothing registered yet" state and passes.

The gate deliberately checks only `source` — the one field that decides whether
a number is real. A registry also carries an `owner` per metric (so a dark
instrument has someone to light it), but naming that is a registry convention,
not this low-false-positive gate's job.

## Mechanism

Native Bun/TypeScript (no shell utilities). It parses each metric's own `id` and
`source` keys (nested content under other keys is ignored) and matches the source against the placeholder set above.

```sh
REGISTRY=metrics-registry.yaml bun ./check-metrics-wired.ts
```

## Where it runs

A [CI](../../../../GLOSSARY.md) gate on any change to the registry (the
authority — see [M1](../../../M1-gates-enforcement-ladder/)); cheap enough to
pre-commit. Run it as the guard that a new metric cannot merge dark: you may add
a metric to the registry, but not with an unwired source.

## Files

| File | Role |
|------|------|
| `check-metrics-wired.ts` | the gate; `REGISTRY` arg/env selects the input |
| `check-metrics-wired.test.ts` | paired self-test (exit codes + the named dark metric) |
| `fixtures/good/metrics-registry.yaml` | every source wired — must pass |
| `fixtures/empty-registry.yaml` | present-but-empty collection — must pass |
| `fixtures/bad/todo-source.yaml` | a `TODO` source — must fail |
| `fixtures/bad/empty-source.yaml` | a blank source — must fail |
| `fixtures/bad/missing-source.yaml` | no source key — must fail |
| `fixtures/bad/placeholder-variants.yaml` | mixed-case placeholders — must fail |
| `fixtures/bad/no-metrics-key.yaml` | no `metrics:` collection — must error |
| `fixtures/bad/mapping-metrics.yaml` | block mapping instead of a list — must error |
| `fixtures/bad/stray-after-item.yaml` | stray key after a valid item — must error |
| `fixtures/good/nested-list.yaml` | a list nested inside an item — must pass as one metric |
| `fixtures/bad/nested-source-overrides.yaml`, `fixtures/bad/nested-keys-override.yaml` | nested `source:`/`id:` under another key must not override the metric's own — must fail |
| `fixtures/good/nested-fields-ignored.yaml` | nested keys and block-scalar text are ignored — must pass |
| `fixtures/good/comment-on-marker.yaml` | a comment after a bare `-` is not a key — must pass |

Run the self-test with `bun test ./check-metrics-wired.test.ts`.
