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
> checked against the catalog in both directions, and every tracked file the
> shortcut calls code-bearing must resolve to *some* area.

Those shortcut checks keep the regex and the catalog in sync; they do not
prove the regex complete. A tracked file the regex treats as non-code is
invisible to them (classifying it is the resolver's job), and "resolves to
some area" is weaker than "resolves to a code-bearing area": a regex that
leaks a docs-only area's prefix passes all three checks and runs the heavy
build for docs-only changes.

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
   checks in both directions keep the regex's literal prefixes and the
   catalog's glob heads from drifting apart. That's narrower than "the
   shortcut can never claim a path the catalog doesn't declare": with `^apps/`
   and a catalog declaring only `apps/web/**`, both directional checks pass,
   yet the shortcut still claims an as-yet-untracked path like
   `apps/mobile/main.ts` as code, since neither check can see a path that
   doesn't exist as a tracked file yet. A third check, `checkFilterFileCoverage`,
   closes that gap for every currently **tracked** file — the two directional
   checks alone don't prove every tracked file the shortcut calls code-bearing
   actually maps to an area — but even all three together don't prove a
   regex-positive file maps to a *code-bearing* area specifically, only *some*
   area, nor say anything about a path no file has been added at yet — see
   [`reference/regex-mirror/README.md`](reference/regex-mirror/README.md)
   for the gap this leaves. Matching must run against the catalog's parsed
   values, not a substring scan of its text.
5. **Coverage gates** — every workspace on disk (`apps/*`, `packages/*`) must
   map to at least one area, and every area's declared workspace must exist and
   be covered by one of its own globs. A new, unmapped workspace fails CI in
   the same PR that introduces it, instead of silently skipping all its gates.

## Design rules

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
  `review`/`postDeploy`/tracker-label block is drift waiting to happen.

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
  CI shortcut is checked against the catalog in both directions *and* for
  tracked-file coverage (`checkFilterFileCoverage`) — bidirectional sync
  checks alone permit a code-bearing file to stay unmapped while still
  passing, so a shortcut retained at Strict is not fully sync-checked
  without the third check. A shortcut that gates deployment instead runs
  the catalog → regex direction against the deploy-critical area class (not
  the general code-area class) and adds `checkFilterCodeAreaCoverage` — see
  [`reference/regex-mirror/README.md`](reference/regex-mirror/README.md) for
  why the area class must change, not just the check count.

## Adoption steps

1. Write one catalog file from [`templates/catalog.yaml`](templates/catalog.yaml)
   (a copyable one-area starter) or
   [`reference/catalog/catalog.example.yaml`](reference/catalog/catalog.example.yaml)
   (exercises every field); validate it against the schema and graph
   invariants in [`reference/catalog/README.md`](reference/catalog/README.md).
   This is **Lite** — consumers can still reference area names by hand.
2. Add a schema/graph CI check and generate at least one consumer projection
   (CI job selection or the review-gate table) from the catalog with a
   freshness gate ([M2](../M2-generated-artifact-freshness/)); gate
   workspace-coverage so a new, unmapped workspace fails CI. This is
   **Standard**.
3. Generate every remaining consumer as a projection, drive CI job selection
   from the resolver itself, and — if you keep a hand-written CI shortcut
   regex — wire it to the regex-mirror guard
   ([`reference/catalog/README.md#the-regex-mirror-guard`](reference/catalog/README.md#the-regex-mirror-guard)),
   using [`reference/regex-mirror/`](reference/regex-mirror/)'s runnable
   `checkFilterSegmentCoverage` script as the regex → catalog half. A
   general "did any code change?" shortcut needs three of the guard's four
   checks, run against the code-area class (the two directional prefix
   checks plus `checkFilterFileCoverage`); a shortcut that instead *gates a
   deploy* needs all four, with the catalog → regex direction re-scoped to
   the deploy-critical area class instead of the code-area class — running
   it against the code-area class while also running the fourth check,
   `checkFilterCodeAreaCoverage`, is unsatisfiable whenever a code-bearing
   area isn't deploy-critical (`deployTier: none`). This is **Strict**.

## Status

What this module provides:

- [`templates/catalog.yaml`](templates/catalog.yaml) — a copyable one-area
  catalog starter.
- [`reference/catalog/catalog.example.yaml`](reference/catalog/catalog.example.yaml)
  — a valid generic catalog that exercises every field and both shapes of
  `impliedBy`.
- [`reference/catalog/README.md`](reference/catalog/README.md) — the
  language-neutral specification: entry schema, schema and graph validation,
  the resolver algorithm, the projections, and the four checks of the
  regex-mirror guard with each one's inputs, algorithm and failure condition.
- [`reference/regex-mirror/`](reference/regex-mirror/) — the runnable
  regex → catalog check (`checkFilterSegmentCoverage`) as a Bun + TypeScript
  gate that matches against parsed `paths:` values, with its self-test and
  fixtures.
- [`mappings.md`](mappings.md) (CI path filters, tracker labels, deploy tiers)
  and the module's [maturity criteria](../../plugin/skills/audit/criteria/M3-change-area-catalog.yaml).

Jig's own catalog (`.config/change-areas.yaml`) is a working instance:
[`scripts/change-areas.ts`](../../scripts/change-areas.ts) validates it,
checks that every file belongs to an area, and resolves a pull request's
changed files to the areas that select its CI jobs. Read it as a worked
example; it knows only the fields Jig's catalog uses.

Deliberately left out: a portable resolver, catalog validator and projection
emitters for other repositories. A change-area resolver is a structured-data
and graph job best written in the language the consumer repository already
uses, so the module specifies it instead of shipping one; only the regex →
catalog check, which needs no resolver, is runnable here as a reference. The
other three guard checks are documented recipes. All area names, deploy tiers
and post-deploy actions are neutral examples.
