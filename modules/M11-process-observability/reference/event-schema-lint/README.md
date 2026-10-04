# Event-schema lint

Process telemetry is only as trustworthy as the events that feed it. If a
`review_completed` event ships without its `outcome`, or a typo'd `gate_reslt`
type slips into the stream, every metric built on those events silently lies.
This gate validates a stream of emitted process events against the closed
`event_types` declared in an [`event-schema.yaml`](../../templates/event-schema.yaml)
— the same discipline [M8](../../../M8-learning-loop/)'s
[corpus-lint](../../../M8-learning-loop/reference/corpus-lint/) applies to eval
fixtures, applied here to telemetry.

## What it enforces

Per event line, against the schema:

| Invariant | Why |
|-----------|-----|
| the event's `type` is a **registered** `event_type` | an unregistered (often typo'd) type drops the event out of every metric that groups by type |
| every field the schema marks **`required`** for that type is present and **non-empty** | a missing or blank required field is a dark measurement dressed as a real one — the metric computes, but on a hole |

Unknown type or a missing/empty required field **fails the gate** (exit 1). A
line that is not parseable as an event (a bare token with no `=`, or no `type=`
at all) or a malformed schema is a **format error** (exit 2), kept distinct from
a real validation failure so a broken pipe never reads as a clean run.

## Event stream format

Portable and jq-free: one event per line, whitespace-separated `key=value`
tokens (logfmt-style). One token must be `type=<event_type>`; a value may itself
contain `=` (only the first splits key from value). Blank lines and `#` comments
are ignored.

```text
type=review_completed pr=482 reviewer=shadow outcome=changes_requested findings=3 cost_unit=12
type=gate_result gate=unresolved-threads result=fail duration_ms=880
type=cycle_time pr=482 stage=open-to-ready elapsed_ms=5400000
```

Your telemetry backend emits richer records (usually JSON); the recipes in
[`mappings.md`](../../mappings.md) show the one-line export that flattens a
period's events into this shape for the gate.

## Mechanism

Native Bun/TypeScript (no shell utilities). It reads the schema's `event_types`
and their `required` flow lists, then checks each event line against them. The
schema defaults to `event-schema.yaml`; override with `SCHEMA=`.

```sh
SCHEMA=event-schema.yaml bun ./check-events.ts events.log
```

## Where it runs

A [CI](../../../../GLOSSARY.md) gate wherever events are exported for
aggregation — a per-PR check over a captured stream, or a scheduled check over a
window (see [M1](../../../M1-gates-enforcement-ladder/) for CI-as-authority).
Cheap enough to always-run.

## Files

| File | Role |
|------|------|
| `check-events.ts` | the gate; `EVENTS` arg + `SCHEMA` env select inputs |
| `check-events.test.ts` | paired self-test (exit codes + the offending type/field in the report) |
| `fixtures/schema.yaml` | the small event schema the fixtures validate against |
| `fixtures/good/events.log` | a valid stream — must pass |
| `fixtures/empty.log` | no events — must pass |
| `fixtures/bad/*.log` | one file per failure mode (unknown type, missing/empty required, malformed) |
| `fixtures/bad/schema-*.yaml` | malformed schemas — must error |

Run the self-test with `bun test ./check-events.test.ts`.
