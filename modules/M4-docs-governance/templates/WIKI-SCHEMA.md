<!--
  TEMPLATE — copy this to your repo (e.g. docs/WIKI-SCHEMA.md), adapt the
  domain folders and authority order to your project, and point your
  instruction file at it. It is the written governance model; the mechanical
  enforcement lives in the frontmatter schema, the checker, the index
  generator, and the scar lint (the gates of Jig's docs skill,
  plugin/skills/docs/scripts/, which /jig:docs runs in one pass).
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

`last_updated` moves with the document: a change to a doc's body must advance
it in the same change (a CI gate checks the diff). A generator that writes into
this tree advances the date only when its output changed, in UTC.

Some subtrees carry extra rules, declared under `path_rules:` in the schema:
fields their documents must carry, values narrowed from the tree's
vocabulary, and body text they must not contain outside code fences.

### Supported YAML subset

The frontmatter check reads an explicit subset of YAML, not full YAML, and
rejects anything outside it with the line number, rather than guessing at a
value. Write inside it:

- **Read:** YAML's whitespace (a space or a tab, so U+00A0 is content) and
  line breaks (a line feed, a carriage return and line feed, or a carriage
  return on its own); `key: value` plain scalars,
  one per line; trailing comments (a `#`
  outside quotes, at the start of the value or after a space); quoted scalars,
  whose quotes come off and whose content is never decoded (no YAML escapes,
  though a double-quoted value may hold only the escapes YAML defines),
  a quote opening one only as a value's or list member's first character (so
  an apostrophe inside a plain value is text); inline lists `[a, b]` and
  block sequences (`key:` then `- item` lines indented under the key, all at
  one indentation); block scalars with a header of `|`, `>`, `|-`, `|+`, `>-`,
  `>+`, or those with an indentation digit before the sign, read with YAML's
  indentation, folding and line-ending rules (a comment indented less than
  the content ends the block); and `null`, `~` or an empty
  value, read as absent.
- **Rejected:** characters YAML does not allow (control characters other than tab), tabs in indentation, anchors and aliases (`&a`, `*a`),
  explicit tags (`!!str`), explicit keys (`? key`), quoted keys, flow mappings
  (`{a: b}`), nested mappings, a plain value continued on the next line,
  containing `: `, or starting with a reserved character (`@`, `` ` ``, `%`,
  `]`, `}`, `,`) or `- ` (quote it), a plain list member containing brackets
  or braces, duplicate keys, an unterminated quoted scalar, list members at
  column 0, a block scalar as a list member (`- |`), and any other
  block-scalar header.

The checker's self-test is the exhaustive list, a fixture for each construct
([frontmatter check](https://github.com/jig-harness/jig/blob/main/plugin/skills/docs/scripts/frontmatter-check/README.md#supported-yaml-subset)).

## Navigation is generated

`INDEX.md` is regenerated from the tree (Jig's index generator); never edit it
by hand. A freshness gate fails when the committed index no longer matches the
tree. The same generator writes `.orphans.md`: the pages no other page lists
under `related:`. Orphans are a warning to link or retire a page, never a
failure.

## De-scarring rule

An **approved** doc is a clean statement of current truth. Review findings and
correction traces — *scars* — do not belong in it:

- strikethrough (`~~removed text~~`) showing what was corrected,
- resolution phrasing in the body ("addressed", "fixed as suggested", "good
  catch", "as per review", "as requested"),
- reviewer-dialogue or attribution blocks naming a reviewer or review bot.

A doc may not move to (or remain at) `status: approved` while carrying scars.
The finding belongs in the review thread, the tracking issue, git/PR history,
or a light `## Version history` section that records *what changed* — never
reviewer names, "addressed" ledgers, or struck-through text. A lint enforces
this (Jig's scar lint); docs whose subject *is* the review process
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

Run periodically (manually, with `/jig:docs`, or a scheduled job);
append findings to `log.md`:

| Check | Flags | Severity |
|-------|-------|----------|
| Index drift | files not in `INDEX.md` | warning |
| Stale content | `last_updated` > 6 months on active docs | warning |
| Broken links | internal links to missing files | error |
| Orphaned pages | listed in no page's `related:` (`.orphans.md`) | warning |
| Missing frontmatter | required fields absent | error |
| Contradictions | conflicting claims across docs (manual) | critical |
| Retrospection backlog | raw entries not yet promoted | info |

Index drift, orphans and missing frontmatter are automated by the generator
and checker; the rest are a documented cadence until mechanized.

## Naming conventions

- kebab-case filenames.
- ADRs: `ADR-NNNN-<slug>.md` (see M5).
- research/analysis: `<topic>-YYYY-MM-DD.md` (folders sort by topic).
- session logs: `YYYY-MM-DD-<slug>.md` (folders sort chronologically).
