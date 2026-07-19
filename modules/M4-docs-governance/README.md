# M4 — Docs-as-wiki governance

**What problem this solves.** Documentation trees grow into hundreds of files
nobody can navigate or trust: no lifecycle, stale content indistinguishable
from current, no defined home for new knowledge — so agents (and people)
re-derive what was already written, and finished documents carry the scars of
the review that produced them. This module governs the docs tree like a living
wiki: machine-validated metadata on every doc, generated navigation, an
activity log, a promotion pipeline from raw session notes to durable pages, and
a de-scarring rule that keeps approved documents clean.

## Invariant

> Every doc carries machine-validated frontmatter (type, status, lifecycle,
> owner, freshness); navigation is *generated*, never hand-curated; knowledge
> flows raw → compiled → indexed; approved documents are scar-free (review
> findings live in threads/issues, not the artifact); and conflicts resolve
> along a written authority hierarchy.

## The three-layer model

Knowledge moves up three layers, each promoting into the next:

1. **Raw sources** — unstructured capture: session logs, debugging records,
   post-mortems, feedback (`retrospection/`), and working notes (`scratch/`).
   Cheap to write, expected to be temporary.
2. **Compiled wiki** — structured, frontmatter-bearing pages organized by
   domain. The queryable knowledge. Reusable lessons are *promoted* out of raw
   sources into here; the un-promoted backlog is tracked by the lint.
3. **Navigation & meta** — the wayfinding layer: a generated `INDEX.md` (read
   first), this schema doc, an `AGENTS.md`/instruction layer, a `log.md`
   activity journal, and `connections/` cross-domain pages.

## Core pieces

1. **Frontmatter schema** — a machine-readable schema (`frontmatter-schema.yaml`)
   fixing the vocabulary: a closed set of doc **types**, **statuses**,
   **lifecycle** horizons, and **owners**, a canonical **tag** list, and a
   "did-you-mean" suggestion map that steers common wrong values toward the
   canonical one instead of blindly rejecting. Validated by a blocking check.
2. **Generated index + freshness gate** — a script walks the tree, reads each
   doc's frontmatter, and regenerates `INDEX.md` (grouped, sorted). A drift
   gate fails when the committed index no longer
   matches the tree — this is [M2](../M2-generated-artifact-freshness/)'s
   freshness triad applied to navigation.
3. **De-scarring rule + scar lint** — an approved doc is a clean statement of
   current truth; review findings and correction traces (strikethroughs,
   "addressed as suggested", reviewer-dialogue blocks) are *scars* that belong
   in the review thread, the tracking issue, or a light `## Version history` —
   never the artifact. A lint detects scars in changed approved docs.
4. **Authority hierarchy** — a written precedence order for resolving
   contradictions between docs (generated ground-truth > decision records >
   domain references > feature docs > historical retrospection), so "which doc
   wins?" is never a judgment call.
5. **Activity log + wiki-lint cadence** — `log.md` journals every ingest and
   lint run; a periodic lint table (index drift, stale >6mo, broken links,
   orphans, missing frontmatter, contradictions, retrospection backlog) keeps
   the tree healthy, its findings appended to the log.

## Maturity levels

- **Lite** — a written governance model: a schema doc naming the frontmatter
  fields, status/lifecycle vocabulary, and the de-scarring rule; new docs start
  from a template rather than a copied neighbor. Enforcement may be
  convention-only.
- **Standard** — frontmatter is machine-validated in CI (required fields, enum
  membership, date format); the index is generated with a freshness gate; the
  authority hierarchy is written. De-scarring is at least an advisory lint.
- **Strict** — de-scarring lint blocks promotion to `approved`; a stale-doc
  gate requires `last_updated` to advance when a doc's body changes; the
  wiki-lint cadence runs on a schedule and posts to the log; raw → compiled
  promotion (retrospection backlog) is tracked.

## Port status

| Source (docomply `develop`) | Landed as |
|-----------------------------|-----------|
| `docs/WIKI-SCHEMA.md` (governance model, authority hierarchy, lint table) | [`templates/WIKI-SCHEMA.md`](templates/WIKI-SCHEMA.md) — copyable governance-model skeleton, IP-scrubbed |
| `docs/.frontmatter-schema.yaml` (types/statuses/lifecycle/owners/tags + suggestions) | [`templates/frontmatter-schema.yaml`](templates/frontmatter-schema.yaml) — generic schema with neutral enums |
| `.claude/scripts/frontmatter-check.sh` (schema validator) | [`reference/frontmatter-check/`](reference/frontmatter-check/) — portable checker + self-test + fixtures |
| `scripts/check-descarring-scars.sh` (+ its self-test) — the C4 de-scarring rule | [`reference/scar-lint/`](reference/scar-lint/) — portable scar detector with code-masking + self-test + fixtures |
| `tools/docs/generate-index.ts` (index generator + freshness gate) | [`reference/index/`](reference/index/) — portable frontmatter-aware generator (orphan reporting documented as a not-yet-ported extension); freshness-gate wiring reuses M2's triad |

Also landed: [`mappings.md`](mappings.md) (CI providers, hook managers, schema
formats) and [`maturity.yaml`](maturity.yaml).

**Not ported** (per "don't port the unproven" / IP scrub): the tag-merge
normalizer and the full ~50-tag canonical taxonomy (domain-specific values —
the *mechanism* of a canonical list + merge map is documented in the schema
template, seeded with neutral tags); the connections/ page schema and the
scheduled wiki-lint workflow (documented as future in the lint table — the
manual cadence is the proven part); the reference index generator is TypeScript
upstream and is represented here as a portable script that covers the same
walk-and-emit contract, not a transcription.
