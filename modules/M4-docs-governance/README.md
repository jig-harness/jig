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

## Adoption steps

1. Copy [`templates/WIKI-SCHEMA.md`](templates/WIKI-SCHEMA.md) into your docs
   tree, adapt the domain folders and the authority order, and link it from
   the instruction file; start new docs from a template with valid
   frontmatter. This is **Lite**.
2. Copy [`templates/frontmatter-schema.yaml`](templates/frontmatter-schema.yaml),
   run [`reference/frontmatter-check/`](reference/frontmatter-check/) in CI on
   changed docs, generate the index with [`reference/index/`](reference/index/)
   and gate its freshness, and run [`reference/scar-lint/`](reference/scar-lint/)
   as at least an advisory check. This is **Standard**.
3. Make the scar lint block promotion to `approved`, add a check that
   `last_updated` advances when a doc's body changes, schedule the wiki-lint
   table, and track the backlog of raw notes awaiting promotion. This is
   **Strict**.

## Status

What this module provides:

- [`templates/WIKI-SCHEMA.md`](templates/WIKI-SCHEMA.md) — the written
  governance model: the three layers, frontmatter, de-scarring, the authority
  hierarchy, the wiki-lint table and naming conventions.
- [`templates/frontmatter-schema.yaml`](templates/frontmatter-schema.yaml) —
  the closed vocabularies (types, statuses, lifecycle horizons, owners), a
  neutral canonical tag list, the "did you mean" suggestions and a tag merge
  map.
- [`reference/frontmatter-check/`](reference/frontmatter-check/) — validates
  every doc's frontmatter against that schema, read at run time.
- [`reference/index/`](reference/index/) — generates `INDEX.md` from
  frontmatter, with a `--check` freshness gate.
- [`reference/scar-lint/`](reference/scar-lint/) — finds scars in approved
  docs, with code masked first.
- [`reference/docs.ts`](reference/docs.ts) — the small frontmatter reader the
  three scripts share.
- [`mappings.md`](mappings.md) (CI providers, hook managers, schema formats)
  and [`maturity.yaml`](maturity.yaml).

Each reference script has a paired self-test beside it. The
[`/jig:descar`](../../plugin/skills/descar/SKILL.md) skill is the
operating procedure for the de-scarring rule: it handles the part a lint
cannot do. [`/jig:promote-memory`](../../plugin/skills/promote-memory/SKILL.md)
promotes a lesson from an agent's private memory into this docs tree.

Deliberately left out: a tag-merge normalizer and a full canonical tag
taxonomy, because a tag list is a repository's domain values; the schema
template shows the mechanism (a canonical list plus a merge map) with neutral
tags.

Future: orphan reporting in the index generator (its design is in
[`reference/index/README.md`](reference/index/README.md#orphan-reporting-extension)),
the diff-aware stale-`last_updated` gate (sketched in
[`reference/frontmatter-check/README.md`](reference/frontmatter-check/README.md#the-stale-last_updated-gate-futurestrict)),
a schema for `connections/` pages, and a scheduled wiki-lint workflow; the
lint table runs as a manual cadence until then.
