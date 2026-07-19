# Decisions-become-checks

Prose ADRs don't self-enforce. A decision written a year ago is silently
violated by code written today, because nobody re-reads 80 decision records
before each change. The fix is to distill the *pattern-checkable* part of each
ADR into a machine-readable rule and let a gate enforce it — turning "we decided
X" into "CI enforces X".

The rules live in data ([`../../templates/adr-rules.yaml`](../../templates/adr-rules.yaml)),
each citing the ADR it derives from, and [`adr-rules-check.sh`](adr-rules-check.sh)
is a **generic interpreter** of that catalog. (The reference implementation
hand-codes each rule in a bespoke script — but a per-rule script is exactly what
a rules catalog exists to avoid, so groundwork ports the generic mechanism.)

## The two rule shapes

- **deny-on-match** — a `pattern` that must not appear. A matching line is a
  violation (a forbidden construct: "use the structured logger, not
  `console.log`").
- **require-nearby** — a `pattern` that must be accompanied by a `follow_check`
  pattern within a few lines. A `pattern` match *without* the companion is a
  violation (a required companion is missing: "every `fetch(` passes a
  timeout"). This is the allow/require inversion.

Each rule carries `exclude` globs (where it's silent, e.g. tests) and a
`severity`: `critical` fails the check; `warning`/`info` report but pass, unless
`STRICT=1` promotes everything to blocking.

## Usage

```sh
# check specific files (in a hook/CI, the staged/changed code files)
RULES=.adr-rules.yaml adr-rules-check.sh $(git diff --cached --name-only --diff-filter=ACM)

# fail on warnings too
STRICT=1 RULES=.adr-rules.yaml adr-rules-check.sh <files...>
```

Wire it into pre-commit over the changed code files (fast feedback) and into CI
as the authority (see [`../../mappings.md`](../../mappings.md)).

## Scope and honesty about greps

This is deliberately a **grep-tier** gate: cheap, transparent, and good enough
for the pattern-matchable subset of decisions. It is not a linter or a type
checker — it does not parse code, so it will have false positives (a `pattern`
inside a comment or string) and false negatives. Two consequences:

- Keep patterns tight and use `exclude` to carve out where a rule is noise.
- Decisions that need real language understanding ("this endpoint must be
  authorized") are **not** for this tier — they belong with the review harness
  ([M7](../../../M7-pr-lifecycle-review/)) and are left out of `adr-rules.yaml`
  on purpose.

The interpreter ships with a self-test proving both rule shapes, the excludes,
and severity handling still work — a rule gate that silently stops matching is
worse than none.

## Files

| File | Role |
|------|------|
| `adr-rules-check.sh` | the generic interpreter (deny-on-match + require-nearby) |
| `test-adr-rules-check.sh` | paired self-test |
| `fixtures/adr-rules.yaml` | the example rules catalog the test runs against |
| `fixtures/clean/`, `fixtures/bad/` | code that passes / trips each rule shape |
