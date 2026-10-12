# Decisions-become-checks

Prose ADRs don't self-enforce. A decision written a year ago is silently
violated by code written today, because nobody re-reads 80 decision records
before each change. The fix is to distill the *pattern-checkable* part of each
ADR into a machine-readable rule and let a gate enforce it — turning "we decided
X" into "CI enforces X".

The rules live in data ([`../../templates/adr-rules.yaml`](../../templates/adr-rules.yaml)),
each citing the ADR it derives from, and [`adr-rules-check.ts`](adr-rules-check.ts)
is a **generic interpreter** of that catalog — never one hand-written script
per rule, which is exactly what a rules catalog exists to avoid.

## The two rule shapes

- **deny-on-match** — a `pattern` that must not appear. A matching line is a
  violation (a forbidden construct: "use the structured logger, not
  `console.log`").
- **require-nearby** — a `pattern` that must be accompanied by a `follow_check`
  pattern on the same line or within the next `WINDOW` lines (default 2). A `pattern` match *without* the companion is a
  violation (a required companion is missing: "every `fetch(` passes a
  timeout"). This is the allow/require inversion.

Each rule carries `exclude` globs (where it's silent, e.g. tests) and a
`severity`: `critical` fails the check; `warning`/`info` report but pass, unless
`STRICT=1` promotes everything to blocking.

## Usage

```sh
# check specific files (in a hook/CI, the staged/changed code files)
RULES=.adr-rules.yaml bun adr-rules-check.ts $(git diff --cached --name-only --diff-filter=ACM)

# fail on warnings too
STRICT=1 RULES=.adr-rules.yaml bun adr-rules-check.ts <files...>
```

`RULES` names the catalog (default `.adr-rules.yaml`). With no files given it
passes. Exit codes: 0 no blocking violation, 1 a `critical` violation (or any
violation under `STRICT=1`), 2 a missing rules file or an invalid pattern.
Binary files are skipped for deny-on-match rules. The interpreter reads
`pattern_rules` line by line rather than through a YAML parser, so keep each
field on one line in the shape the template shows.

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
| `adr-rules-check.ts` | the generic interpreter (deny-on-match + require-nearby) |
| `adr-rules-check.test.ts` | paired self-test |
| `fixtures/adr-rules.yaml` | the example rules catalog the test runs against |
| `fixtures/clean/`, `fixtures/bad/` | code that passes / trips each rule shape |
