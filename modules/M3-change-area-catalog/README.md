# M3 — Change-area catalog

**What problem this solves.** Every repo constantly answers the same question:
"what *kind* of change is this, and what must happen because of it?" — which CI
jobs run, which reviews are mandatory, which deploy tier applies, which tracker
labels to set, which post-deploy step to trigger. That mapping usually lives as
duplicated path-lists scattered across CI configs, review docs, deploy scripts,
and reviewer habits — and the copies quietly disagree, so a change slips
through with the wrong gates. This module makes the mapping **one
machine-readable catalog** (path patterns → implications) from which every
consumer view is *generated*, and mechanically keeps any hand-maintained
shortcut honest against it.

## Invariant

> One validated catalog file maps path patterns to named change-areas and their
> implications. Consumers (CI job selection, review-gate tables, tracker
> labels, deploy tiers, post-deploy actions) are **generated projections** that
> reference area *names* — they never re-hardcode the patterns. Any
> hand-maintained shortcut (e.g. a fast-path regex in CI) is mechanically
> checked against the catalog in both directions, so neither can gain or lose a
> path without the other.

The catalog is a *single source of truth* (see [GLOSSARY.md](../../GLOSSARY.md)):
one shared change-area vocabulary, many thin per-consumer projections.

## Core pieces

1. **The catalog** — one YAML file. Each entry is a named *change-area* (a
   kebab-case id) with the globs that define its membership plus its
   implications: owning workspace(s), deploy tier, review skills, tracker
   labels, post-deploy actions, and an `impliedBy` list — the one relation that
   encodes dependencies between areas.
2. **The resolver** — pure function: a set of changed file paths → the seed
   areas whose globs match → the transitive closure over `impliedBy` → the
   union of all their implications. One directed relation expresses both
   fan-out (one shared library implies every app that lists it) and fan-in (one
   aggregator area lists many sources in its own `impliedBy`).
3. **Projections (generated)** — the per-consumer views emitted from the
   catalog: a CI path-filter, a review-gate table, a component directory, a
   post-deploy checklist, tracker-label sets, a JSON resolution for other
   tooling. Each is freshness-gated (see [M2](../M2-generated-artifact-freshness/)):
   a committed projection that no longer matches the catalog fails CI.
4. **The regex-mirror guard** — when a repo keeps a fast hand-written CI regex
   ("did any *code* change?") to avoid running the full resolver on every event,
   two checks keep the regex and the catalog in sync **both ways**, so the
   shortcut can never silently diverge from the source of truth.
5. **Coverage gates** — every workspace on disk (`apps/*`, `packages/*`) must
   map to at least one area, and every area's declared workspace must exist and
   be covered by one of its own globs. A new, unmapped workspace fails CI in
   the same PR that introduces it, instead of silently skipping all its gates.

## Design rules (from the reference implementation)

- **`impliedBy` is one directed relation, read one way**: "a change to Y also
  implies X" is written by listing Y in X's `impliedBy`. Fan-out and fan-in are
  just its two shapes — don't add a reverse relation.
- **Membership is multi-valued by design**: globs may overlap; one file can
  seed several areas (a subset area, a generated file matching two areas).
- **Conservative over-trigger, never under-trigger**: when unsure whether a
  dependency exists, add the `impliedBy` edge. A redundant CI job is cheap; a
  skipped mandatory review is not.
- **`category` is a grouping tag only** — never a build or deploy lane. Lanes
  are `deployTier` and the projections.
- **Don't populate a projection block before its consumer exists** — an empty
  `review`/`postDeploy`/`linear` block is drift waiting to happen.

## Maturity levels

- **Lite** — one catalog file is the single place path→area→implication is
  written; consumers reference area names (even if some projections are still
  hand-copied). A schema/structure check validates the file (kebab-case ids,
  `impliedBy` refs resolve, no self-implication).
- **Standard** — the catalog is schema-validated *and* graph-validated
  (referential integrity, no cycles) in CI; at least one consumer view (CI
  selection or the review-gate table) is a generated projection with a
  freshness gate; workspace-coverage is gated.
- **Strict** — every consumer is a generated projection with a freshness gate;
  the resolver drives CI job selection mechanically; and any hand-maintained
  CI shortcut is bidirectionally sync-checked against the catalog.

## Port status

| Source (docomply `develop`) | Landed as |
|-----------------------------|-----------|
| `tools/change-areas/catalog.yaml` (entry shape) | [`reference/catalog/catalog.example.yaml`](reference/catalog/catalog.example.yaml) — a fully valid generic catalog exercising every field; [`templates/catalog.yaml`](templates/catalog.yaml) — a copyable one-area starter |
| `schema.ts` + `check-catalog.ts` (schema + graph invariants) | [`reference/catalog/README.md`](reference/catalog/README.md) — the schema and the graph invariants as a language-neutral spec, with the resolver algorithm |
| `resolve.ts` (seed match → `impliedBy` closure), `emit.ts` (projection emitters) | Documented as an algorithm + the projection list in [`reference/catalog/README.md`](reference/catalog/README.md) |
| `scripts/check-detect-changes-catalog-sync.sh` + `checkFilterCoverage` (regex-mirror guard) | [`reference/regex-mirror/`](reference/regex-mirror/) — the runnable regex→catalog sync check with a self-test and fixtures, and the catalog→regex direction as a documented recipe |

Also landed: [`mappings.md`](mappings.md) (CI path-filter providers, tracker
labels, deploy tiers) and [`maturity.yaml`](maturity.yaml).

**Not ported** (per "don't port the unproven" / values-vs-mechanisms): the
resolver, validators, and emitters are TypeScript in the reference
implementation and are represented here as a language-neutral spec plus the one
guard that is genuinely portable as a shell script — a change-area resolver is
a structured-data + graph job best written in whatever language the target repo
already uses, not reimplemented in bash. The docomply catalog's actual area
names, deploy tiers, and post-deploy actions are product-domain values and are
replaced throughout with neutral examples.
