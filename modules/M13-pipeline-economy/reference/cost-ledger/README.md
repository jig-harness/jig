# Cost-ledger check

Part of [M13 Pipeline economy](../../README.md).

Every decision that changes what a pipeline spends trades something: a
runner resized, a pre-push leg narrowed, a suite moved to a schedule, a
cache turned on. A trade without a number is re-argued at every round. A
decision recorded with "reopen if it gets expensive" is never reopened,
because nobody can say when "expensive" arrived; one whose reopen condition
names a metric nobody collects is dark; and one whose after-measurement was
"coming" stays unmeasured for good unless something fails when its date
passes.

`check-cost-ledger.ts` reads a cost ledger
([`templates/ci-cost-ledger.yaml`](../../templates/ci-cost-ledger.yaml))
and fails when any decision lacks its measurement before and after, is past
the date its after-measurement was due, or carries a reopen condition that
cannot be checked. With a metrics registry
([M11's `metrics-registry.yaml`](../../../M11-process-observability/templates/metrics-registry.yaml))
it also fails a condition over a metric the registry does not carry. It
only detects; it changes nothing.

## Usage

```bash
bun check-cost-ledger.ts [--metrics metrics-registry.yaml] [--now YYYY-MM-DD] ci-cost-ledger.yaml
```

- `--metrics` — the metrics registry whose ids a reopen condition may name.
  Without it the metric is not checked, and the pass line says so.
- `--now` — the day to judge a due date against; default today (UTC).
  Tests and replays pass a fixed value.

The script imports helpers from the Jig repository's `lib/` (`cli.ts`,
`findings.ts`, `record.ts`, `workflows.ts` and its vendored YAML parser), so
run it from a pinned Jig checkout; a copy of the script alone leaves imports
that do not resolve.

## The ledger

A mapping with `version: 1` and a `decisions` list, empty until the first
decision. Each decision:

| Field | Rule |
| --- | --- |
| `id` | a kebab-case slug, unique in the ledger |
| `decision` | one non-empty line: what changed |
| `measured.unit` | a non-empty string: what the numbers are |
| `measured.before` | a finite number |
| `measured.after` | required: a finite number; or an explicit `null` with `measure_by`, a calendar date (`YYYY-MM-DD`) that is not before the day the check runs (a missing field is a finding, not a pending measurement) |
| `measured.windows` | optional: the two windows the numbers come from, `[before, after]` |
| `reopen` | a non-empty list; each entry has `metric` (a kebab-case id, and one the registry carries when a registry is given), `comparator` (`>`, `>=`, `<` or `<=`), `threshold` (a finite number) and `window` (`30d`, `4w`, `6m`, `12h` or `100 runs`); `then` is optional |

Other fields (`date`, `then`) pass through unchecked.

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Every decision is measured and reopenable, or the list is still empty | `OK — <n> decision(s) in <ledger>, …` and whether the metrics were checked against a registry; `OK — 0 decision(s) in <ledger>: nothing to check yet` for an empty `decisions` list |
| 1 | At least one finding | one finding per problem on standard error, `<ledger>:<line>: [cost-ledger] <problem>` then `fix: <remedy>`, where the line is the decision's `id:`; a count on standard output |
| 2 | Usage or input error | `cost-ledger: could not check: <reason>` on standard error |

The script fails closed: a ledger it cannot read or parse, one that is not a
mapping with `version: 1` and a `decisions` list, a registry it cannot read
or without a `metrics` list, a `--now` that is not a calendar date, or a bad
option exits 2. Input it could not read never passes. An empty `decisions`
list is readable input, and a legitimate state: a pipeline that has made no
cost decision yet.

## Wiring it

Run it in CI on changes to the ledger and the registry, beside the other
workflow-file checks, and in the pre-push hook if the ledger changes
often. Wire it with the ledger's first commit, before the first decision:
an empty list passes, and the check starts checking when the first entry
arrives. A decision whose after-measurement is pending fails the check on the
first run after its due date, whatever changed: that is the point, so give
the run that catches it a job someone reads, or run the check on a schedule
as well.

## What it leaves to the team

The script checks that a reopen condition *can* be checked; checking it is
the team's scheduled measurement (the README's piece 11), which reads the
metric and compares. Whether a crossed threshold reopens the decision in the
tracker, or only in the next cost review, is each repository's choice.
