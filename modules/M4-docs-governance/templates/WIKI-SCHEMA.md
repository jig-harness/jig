<!--
  TEMPLATE — copy this to your repo (e.g. docs/WIKI-SCHEMA.md), adapt the
  domain folders and authority order to your project, and point your
  instruction file at it. It is the written governance model; the mechanical
  enforcement lives in the frontmatter schema, the checker, the index
  generator, and the scar lint (see the M4 reference/ directory).
-->

# Wiki schema — how this docs tree is governed

The `docs/` tree is a living wiki maintained jointly by people and agents. This
file is the rulebook. Read `INDEX.md` first for *what* exists; read this for
*how* it is organized and kept trustworthy.

## Three-layer model

1. **Raw sources** (`retrospection/`, `scratch/`) — unstructured capture:
   session logs, debugging records, post-mortems, working notes. Temporary by
   default.
2. **Compiled wiki** — structured, frontmatter-bearing pages grouped by domain.
   The queryable knowledge. Promote reusable lessons up from raw sources.
3. **Navigation & meta** — `INDEX.md` (generated), this schema, `log.md`
   (activity journal), `connections/` (cross-domain pages).

## Frontmatter

Every doc opens with YAML frontmatter validated against
`.frontmatter-schema.yaml` (a blocking check). Required on every doc: `title`,
`type`, `status`, `lifecycle`, `last_updated`, `owner`, `tags`. New docs also
require `description`. ADRs additionally require `decision_date`, `supersedes`,
`superseded_by`. See the schema file for the closed enum vocabularies (types,
statuses, lifecycle horizons, owners) and the canonical tag list.

```yaml
---
title: "Caching Layer Design"
type: architecture
status: approved
lifecycle: permanent
last_updated: 2026-07-19
owner: engineering
description: How the read-through cache is structured and invalidated
tags: [backend, performance, database]
---
```

## Navigation is generated

`INDEX.md` is regenerated from the tree (see `reference/index/`); never edit it
by hand. A freshness gate fails when the committed index no longer matches the
tree. Pages with no incoming links are reported as orphans.

## De-scarring rule

An **approved** doc is a clean statement of current truth. Review findings and
correction traces — *scars* — do not belong in it:

- strikethrough (`~~removed text~~`) showing what was corrected,
- resolution phrasing in the body ("addressed", "fixed as suggested", "good
  catch", "as per review"),
- reviewer-dialogue or attribution blocks naming a reviewer or review bot.

A doc may not move to (or remain at) `status: approved` while carrying scars.
The finding belongs in the review thread, the tracking issue, git/PR history,
or a light `## Version history` section that records *what changed* — never
reviewer names, "addressed" ledgers, or struck-through text. A lint enforces
this (see `reference/scar-lint/`); docs whose subject *is* the review process
opt out via a path allowlist or a `descar_allow: true` frontmatter key.

## Authority hierarchy (conflict resolution)

When two docs disagree, the higher source wins — no judgment call:

1. generated ground truth (database schema, API spec) — regenerated, not hand-written
2. decision records (ADRs) — decisions with rationale
3. domain-model references — entities, roles, permissions
4. feature docs — implementation detail
5. retrospection — historical context

Adapt the order to your repo, but write it down and keep it single-valued.

## Wiki-lint cadence

Run periodically (manually, via a `/docs-lint` skill, or a scheduled job);
append findings to `log.md`:

| Check | Flags | Severity |
|-------|-------|----------|
| Index drift | files not in `INDEX.md` | warning |
| Stale content | `last_updated` > 6 months on active docs | warning |
| Broken links | internal links to missing files | error |
| Orphaned pages | no incoming links | warning |
| Missing frontmatter | required fields absent | error |
| Contradictions | conflicting claims across docs (manual) | critical |
| Retrospection backlog | raw entries not yet promoted | info |

Index drift, orphans, and missing frontmatter are automated by the generator
and checker; the rest are a documented cadence until mechanized.

## Naming conventions

- kebab-case filenames.
- ADRs: `ADR-NNNN-<slug>.md` (see M5).
- research/analysis: `<topic>-YYYY-MM-DD.md` (folders sort by topic).
- session logs: `YYYY-MM-DD-<slug>.md` (folders sort chronologically).
