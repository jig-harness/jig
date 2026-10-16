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
   canonical one instead of blindly rejecting. Validated by a blocking check
   that reads an explicit, documented subset of YAML and rejects anything
   outside it rather than guessing.
   [Path-scoped rules](../../GLOSSARY.md) add requirements for a subtree
   whose vocabulary differs from the rest (a runbook directory, an archive).
2. **Generated index + freshness gate** — a script walks the tree, reads each
   doc's frontmatter, and regenerates `INDEX.md` (grouped, sorted). A drift
   gate fails when the committed index no longer
   matches the tree — this is [M2](../M2-generated-artifact-freshness/)'s
   freshness triad applied to navigation. The same generator writes an
   [orphan report](../../GLOSSARY.md): the documents no other document lists
   as related, a warning that never blocks.
3. **Honest freshness dates** — a diff-aware gate requires `last_updated` to
   advance whenever a doc's body changes. Generators that write into the docs
   tree stamp the date [sticky](../../GLOSSARY.md): advanced in UTC only when
   their output changed, so they neither break the gate nor churn dates.
4. **De-scarring rule + scar lint** — an approved doc is a clean statement of
   current truth; review findings and correction traces (strikethroughs,
   "addressed as suggested", reviewer-dialogue blocks) are *scars* that belong
   in the review thread, the tracking issue, or a light `## Version history` —
   never the artifact. A lint detects scars in changed approved docs, and
   reports a named draft as not scanned rather than clean.
5. **Authority hierarchy** — a written precedence order for resolving
   contradictions between docs (generated ground-truth > decision records >
   domain references > feature docs > historical retrospection), so "which doc
   wins?" is never a judgment call.
6. **Activity log + wiki-lint cadence** — `log.md` journals every ingest and
   lint run; a periodic lint table (index drift, stale >6mo, broken links,
   orphans, missing frontmatter, contradictions, retrospection backlog) keeps
   the tree healthy, its findings appended to the log.
   The docs tree is one [drift-prone area](../../GLOSSARY.md) among others: list it, with its
   cadence, owner and last-audited date, in the repository's
   [audit catalog](../M8-learning-loop/README.md#the-audit-catalog-areas-no-gate-covers).

## Maturity levels

- **Lite** — a written governance model: a schema doc naming the frontmatter
  fields, status/lifecycle vocabulary, and the de-scarring rule; new docs start
  from a template rather than a copied neighbor. Enforcement may be
  convention-only.
- **Standard** — frontmatter is machine-validated in CI (required fields, enum
  membership, date format), by a check that states the YAML subset it reads;
  the index is generated with a freshness gate; the authority hierarchy is
  written. De-scarring is at least an advisory lint.
- **Strict** — de-scarring lint blocks promotion to `approved`; a stale-doc
  gate requires `last_updated` to advance when a doc's body changes, and
  generators stamp their dates sticky in UTC; the orphan report is generated
  with the index; the
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
3. Before tightening any validator (a new required field, a narrowed enum,
   path rules, the YAML subset), bring the existing docs into line with a
   one-shot [codemod](../../GLOSSARY.md) first, or the tightened check blocks
   every docs pull request on day one. Run it as **survey** (a histogram of
   every field's current values), **plan** (a read-only diff per mapping
   family, such as one for status values and one for lifecycle values), then
   **apply**, one commit per mapping family, so each can be reverted on its
   own. Values that occur once or twice go to a triage list for a person to
   decide; they are never corrected automatically.
4. Make the scar lint block promotion to `approved`, run
   [`reference/stale-last-updated/`](reference/stale-last-updated/) in CI and
   the pre-commit hook, stamp generated docs with
   [`reference/stamp/`](reference/stamp/), add path rules where a subtree
   needs them, schedule the wiki-lint table, and track the backlog of raw
   notes awaiting promotion. This is **Strict**.

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
  every doc's frontmatter against that schema, read at run time, including
  its path-scoped rules, and documents the YAML subset it reads.
- [`reference/index/`](reference/index/) — generates `INDEX.md` and the
  orphan report from frontmatter, with a `--check` freshness gate over both.
- [`reference/stale-last-updated/`](reference/stale-last-updated/) — fails a
  diff that changes a doc's body without advancing `last_updated`, over a CI
  diff range or the staged changes.
- [`reference/stamp/`](reference/stamp/) — sticky UTC stamping of
  `last_updated` for generators.
- [`reference/scar-lint/`](reference/scar-lint/) — finds scars in approved
  docs, with code masked first, and reports named files it did not scan.
- [`reference/docs.ts`](reference/docs.ts) — the frontmatter reader the
  scripts share: the YAML subset, with an error for each construct outside it.
- [`mappings.md`](mappings.md) (CI providers, hook managers, schema formats)
  and the module's [maturity criteria](../../plugin/skills/audit/criteria/M4-docs-governance.yaml).

Each reference script has a paired self-test beside it. The
[`/jig:descar`](../../plugin/skills/descar/SKILL.md) skill is the
operating procedure for the de-scarring rule: it handles the part a lint
cannot do. [`/jig:promote-memory`](../../plugin/skills/promote-memory/SKILL.md)
promotes a lesson from an agent's private memory into this docs tree.

Deliberately left out: a tag-merge normalizer and a full canonical tag
taxonomy, because a tag list is a repository's domain values; the schema
template shows the mechanism (a canonical list plus a merge map) with neutral
tags. The frontmatter codemod is a procedure (adoption step 3), not a
reference script, for the same reason: its mapping tables are a repository's
values.

Future: a schema for `connections/` pages; a scheduled wiki-lint workflow
(the lint table runs as a manual cadence until then); and a path rule that
requires each document under a prefix to have a row in that directory's
README.
