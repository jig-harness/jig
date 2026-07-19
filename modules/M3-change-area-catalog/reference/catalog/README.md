# Change-area catalog — schema, resolver, projections

This is the language-neutral specification behind the module
[invariant](../../README.md): one validated catalog, many generated
projections. The worked data file is
[`catalog.example.yaml`](catalog.example.yaml). The reference implementation
codes the schema, resolver, and emitters in TypeScript; a change-area resolver
is a structured-data + graph job, so implement it in whatever language your
repo already uses — this file specifies *what* it must do, not a bash
transcription of it.

## Entry schema

The catalog is a single top-level map `areas:` keyed by kebab-case area ids
(`^[a-z0-9]+(-[a-z0-9]+)*$`). Each entry:

| Field | Req? | Meaning |
|-------|------|---------|
| `title` | required | human-readable name |
| `category` | required | grouping tag only (a closed enum); **never** a build/deploy lane |
| `paths` | required | globs that *define membership* — the vocabulary consumers reference (≥1) |
| `workspace` | required | owning workspace dir(s) (`apps/*`, `packages/*`); empty for path-only areas |
| `impliedBy` | required | area-id references: "a change to any listed area also implies this one" (may be empty) |
| `deployTier` | required | which deploy lane applies (a closed enum incl. a `none`) |
| `notes` | optional | load-bearing semantics kept next to the data |
| `review` | optional | `{ skills: [..] (≥1), notes? }` — mandatory review skills for this area |
| `postDeploy` | optional | `[{ action, when, envs: [..], notes? }]` — post-deploy operational steps |
| `linear` / tracker | optional | `{ labels?: [..], flags?: [..] }` — tracker labels/flags to derive |
| `agent` | optional | owning-agent label (a closed enum) |

Reserved-but-loosely-typed blocks (`ci`, `deploy`, `scaffolding`, `owner`) let
later consumers attach their own projection without a schema break — leave them
out until their consumer exists.

## Schema-level validation

Enforced structurally (a JSON/YAML schema does this cleanly):

- Area ids **and** every `impliedBy` reference match the kebab-case pattern.
- `additionalProperties: false` on the catalog, each area, and each nested
  block — unknown fields are rejected (catches typos like `reviews:`).
- `category`, `deployTier`, `agent`, `postDeploy[].envs`, tracker `flags` are
  **closed literal unions** (fixed vocabularies).
- `paths` ≥1 non-empty string; `review.skills` ≥1; `postDeploy[]` each carry
  ≥1 `envs`.

Schema validation deliberately does **not** check referential integrity or
cycles — a schema-valid catalog may still have a dangling `impliedBy` ref. That
is the graph checker's job.

## Graph validation

Run these after schema validation (see the graph invariants the reference
`check-catalog` enforces):

1. **Referential integrity** — every `impliedBy` ref names an existing area.
2. **No self-implication** — `ref != key`.
3. **No cycles** — a depth-first traversal with visiting/done coloring over
   the directed `impliedBy` relation. A cycle is a modeling error: the closure
   would silently glue its members together forever.
4. **Workspace exists** — every declared `workspace` dir exists on disk
   (catches renamed/removed workspaces).
5. **Workspace covered by glob** — each `workspace` dir is matched by one of
   the area's own `paths` (else the resolver is blind to changes in it).
6. **Coverage** — every `apps/*` and `packages/*` dir on disk maps to ≥1
   area's `workspace`. A new, unmapped workspace fails CI in the same PR that
   adds it, instead of silently skipping all its gates.

## The resolver

A pure function of `(changed file paths, catalog)`, kept separate from any git
plumbing so it is unit-testable:

1. **Seed match** — an area is seeded if *any* changed file matches *any* of
   its `paths` globs. Membership is multi-valued: one file can seed several
   areas.
2. **Implied closure** — forward transitive closure over `impliedBy`. Fixpoint
   loop: repeatedly add any area `K` whose `impliedBy` lists an
   already-included area, until the set stops growing.
3. The resolved set is `closure(seed(files))`; the union of its areas'
   implications is what the projections consume.

**One relation, both shapes.** The edge is always read "X is `impliedBy` Y ⇒ a
change to Y adds X." *Fan-out* (one shared library → every app) is written by
each app listing the library in *its* `impliedBy`. *Fan-in* (many sources → one
aggregator) is written by the aggregator listing many areas in *its own*
`impliedBy`. The closure walks the same direction for both — do not add a
reverse relation.

The git layer that feeds the resolver (picking the right diff per CI event —
`pull_request` base…HEAD, merge-commit parent union, etc.) is repo- and
provider-specific; keep it injectable so the pure resolver stays testable.

## Projections (generated)

Each projection is a pure function of the catalog (and, for the dynamic ones,
a resolution). Every committed projection carries a freshness gate (see
[M2](../../../M2-generated-artifact-freshness/)): regenerate in CI and fail on
a non-empty diff.

| Projection | Kind | Output |
|-----------|------|--------|
| CI path-filter | static | per-area glob set = own `paths` ∪ the `paths` of every area that transitively implies it — a native CI `paths:` filter equivalent to "this area is affected" |
| Per-event area flags | dynamic | `area=true/false` outputs for the CI run's changed files (drives job selection); optionally a synthetic `code=true/false` aggregate |
| Review-gate table | static | Markdown table: area → trigger paths → mandatory review skills |
| Component directory | static | Markdown: apps / packages / infra grouped by `workspace`, with deploy tier + owning agent |
| Post-deploy checklist | dynamic | Markdown checklist of `postDeploy` actions for the affected areas |
| Tracker labels | dynamic | the union of `linear.labels`/`flags` for the affected areas |
| JSON resolution | dynamic | `{ changedFiles, seedAreas, areas, flags, postDeploy }` for other tooling |

## The regex-mirror guard

If the repo keeps a fast hand-written CI regex ("did any *code* change?") to
avoid running the full resolver on every event, that regex is a second copy of
part of the catalog and will drift. Two checks keep them honest **both ways** —
see [`../regex-mirror/`](../regex-mirror/) for the runnable one:

- **regex → catalog**: every path prefix the regex matches must appear in the
  catalog (a runnable shell check; ported here).
- **catalog → regex**: every *code-bearing* area (one whose `impliedBy` closure
  reaches a code area) must have each of its globs matched by the regex — else
  the shortcut would treat a code change as docs-only. This one needs the
  resolver's closure, so it lives with the resolver; the recipe is in
  `../regex-mirror/README.md`.
