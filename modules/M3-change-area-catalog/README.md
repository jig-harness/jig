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
   areas, those whose `paths` or a generator's `source` globs match a changed
   file → the transitive closure over `impliedBy` → the union of all their
   implications. One directed relation expresses both fan-out (one shared
   library implies every app that lists it) and fan-in (one aggregator area
   lists many sources in its own `impliedBy`).
3. **Projections (generated)** — the per-consumer views emitted from the
   catalog: a CI path-filter, per-event CI outputs (one for the closure and
   one for the seeds of each area), a review-gate table, a component
   directory, a post-deploy checklist, tracker labels and flags, and a JSON
   resolution with the change's validation plan for other tooling. Each
   committed one is freshness-gated (see [M2](../M2-generated-artifact-freshness/)):
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
   Brownfield adopters grandfather existing gaps instead of blocking on day
   one — see the pattern in [`adoption/brownfield.md`](../../adoption/brownfield.md#grandfathering-a-coverage-gate)
   and its catalog-specific mechanism in
   [`reference/catalog/README.md`](reference/catalog/README.md#grandfathering-catalog-coverage).
6. **Agent gate depth (`validation:`)** — a projection answering "what must a
   coding agent run before commit and push." The catalog declares its
   [validation profiles](../../GLOSSARY.md) under `profiles:`, shallowest
   first; an area may name one, and an area that names none, like a changed
   file no area matches, gets the deepest. The depth is read from the
   *seeds*, like tracker labels. A repository whose agents must also run on
   a CI-identical remote machine computes that requirement in its own
   [composer](../../GLOSSARY.md), from the seeds' closure, so it still
   protects a dependent the change did not touch. Cross-cuts
   [M1](../M1-gates-enforcement-ladder/) (which gate rung runs) and
   [M12](../M12-parallel-agent-ergonomics/) (a shallow-enough answer can skip
   the cross-worktree heavy-run mutex).
7. **Generated-output coupling (`generated:`)** — an area declares the
   derived files it owns, in [M2](../M2-generated-artifact-freshness/)'s
   inventory format (outputs, source, regenerate command, check), so a
   shallow-profile area can carry one specific
   [freshness gate](../M2-generated-artifact-freshness/) without escalating to
   full validation, the regenerate command isn't triplicated across a
   hook, CI, and prose, and M2's generic runner reads the catalog as the
   inventory and runs every declared check. A change to a generator's
   `source` seeds its owning area, even where the source lies under another
   area's `paths`, so the generator and its check are in that change's plan.

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
- **Every projection reads one side of `impliedBy`, and must say which**:
  the *closure* answers "what are the consequences?" (deploy tiers,
  post-deploy actions, mandatory reviews in `review.skills`); the
  [*seeds*](../../GLOSSARY.md) answer "what did this change touch?" (tracker
  labels and flags, `validation:`, `generated:`). Reviews fail toward
  coverage: a missed review is a defect, an extra one costs one run. Labels
  and flags fail toward accuracy: they are lasting claims on the issue
  record, so an over-derived one is a lasting false statement. A flag that
  must fire for a change goes on an area that change seeds directly. See the
  table in
  [`reference/catalog/README.md`](reference/catalog/README.md#seeds-vs-closure--which-side-each-projection-reads).
- **The catalog's own structural check needs one required hand-written
  shortcut**: a self-check cannot ask its subject whether it should run, so
  the CI step that validates the catalog's own structure must run
  independently of catalog-derived selection — unconditionally on every CI
  event, or behind a literal, hand-written path match on the catalog file —
  never by resolving through the catalog itself, or a change that deletes the
  catalog's own paths would resolve to nothing and skip the very check meant
  to catch that. Where a trigger is used, it is the one hand-maintained
  shortcut this module treats as required, not debt; see [`reference/catalog/README.md`](reference/catalog/README.md#the-self-check-paradox).

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

  In addition, every general code-shortcut-positive file must reach a
  separately corroborated code-bearing anchor through the union of its
  matched areas' closures. Anchors need a source-controlled deployment,
  publish, or enabled heavy-gate reference outside the catalog; see
  [the anchor protocol](reference/regex-mirror/README.md#matching-an-area-is-not-the-same-as-being-code-bearing).

## Adoption steps

1. Write one catalog file from [`templates/catalog.yaml`](templates/catalog.yaml)
   (a copyable one-area starter) or
   [`reference/catalog/catalog.example.yaml`](reference/catalog/catalog.example.yaml)
   (exercises every field); validate it against the schema and graph
   invariants in [`reference/catalog/README.md`](reference/catalog/README.md)
   with `/jig:change-areas` (its `scripts/check.ts`).
   This is **Lite** — consumers can still reference area names by hand.
2. Run that check in CI and generate at least one consumer projection from
   the catalog: CI job selection with the skill's `--format gha` (per-event
   outputs) or `--format dorny` (a path-filter spec, committed with a
   freshness gate, [M2](../M2-generated-artifact-freshness/)), or the
   review-gate table; gate workspace-coverage so a new, unmapped workspace
   fails CI. This is **Standard**.
3. Generate every remaining consumer as a projection, drive CI job selection
   from the resolver itself, and — if you keep a hand-written CI shortcut
   regex — wire it to the regex-mirror guard
   ([`reference/catalog/README.md#the-regex-mirror-guard`](reference/catalog/README.md#the-regex-mirror-guard)),
   using [`reference/regex-mirror/`](reference/regex-mirror/)'s runnable
   `checkFilterSegmentCoverage` script as the regex → catalog half. A
   general "did any code change?" shortcut needs three of the guard's four
   checks, run against the code-area class (the two directional prefix
   checks plus `checkFilterFileCoverage`), together with the independent
   anchor reachability check described below; a shortcut that instead *gates a
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

The runnable form is the plugin's
[`change-areas` skill](../../plugin/skills/change-areas/README.md): the
schema validation, the graph and repository invariants, the resolver with
its git layer, and the projections (CI outputs, a path-filter spec, JSON with
the validation plan, the post-deploy checklist, the review-gate table).
[`reference/catalog/README.md`](reference/catalog/README.md) is the
specification it implements; a repository that implements the resolver in
another language holds it to the same file. A repository whose catalog
needs more than the generic schema runs the skill through a
[composer](../../GLOSSARY.md). Jig's own catalog (`.config/change-areas.yaml`)
does: [`scripts/change-areas.ts`](../../scripts/change-areas.ts) adds Jig's
own field, its outputs and the policy that every file belongs to an area.

How CI uses the resolver (one resolver job per run, gates selected by their
own area, an unmatched file selecting everything) is
[M13 pipeline economy](../M13-pipeline-economy/README.md#2-select).

Deliberately left out: of the regex-mirror guard's checks, only the regex →
catalog one is runnable here; the others are documented recipes rather than
runnable gates. All area names, deploy tiers and post-deploy actions
are neutral examples.

Future: a lint that checks the path lists in agent rules, hook
configuration and CI workflow triggers against the catalog, so a consumer
that restates the catalog's globs is caught when they drift.
