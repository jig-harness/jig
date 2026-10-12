# Frontmatter checker

Validates each doc's YAML frontmatter against the schema
([`../../templates/frontmatter-schema.yaml`](../../templates/frontmatter-schema.yaml)),
so the schema stays the single source of truth for the doc vocabulary and
nothing drifts into invented types or statuses. Native Bun + TypeScript keeps the same check available in local hooks and CI.

## What it checks

Per doc, in [`frontmatter-check.ts`](frontmatter-check.ts):

1. frontmatter present — opens with `---`, closes within the first 60 lines;
2. every required field present;
3. `description` present for **new** docs (files listed in `$NEW_DOCS`) — the
   one field required on creation but grandfathered for existing docs;
4. enum membership for `type` / `status` / `lifecycle` / `owner`, with a "did
   you mean" hint pulled from the schema's `suggestions:` map — so a common
   wrong value (`completed` → `approved`) is corrected, not just rejected;
5. `last_updated` is a strict `YYYY-MM-DD` date;
6. `tags` is a bracketed list, each tag in the canonical list, at most 8;
7. ADR-specific fields (`decision_date`, `supersedes`, `superseded_by`) when
   `type: adr` — the bridge to [M5](../../../M5-adr-practice/).

The script uses the shared [`../docs.ts`](../docs.ts) reader. When adopting
these files, keep that helper in the parent directory and run them with Bun.

## Usage

`SCHEMA` names the schema file (default `docs/.frontmatter-schema.yaml`),
`DOCS_DIR` the tree to scan when no files are given (default `docs`), and
`NEW_DOCS` a space-separated list of files that also need `description`. Exit
codes: 0 all docs valid, 1 at least one violation, 2 a missing schema or an
unreadable file.

```sh
# explicit files (what hooks/CI pass)
SCHEMA=docs/.frontmatter-schema.yaml bun frontmatter-check.ts docs/a.md docs/b.md

# new docs also require `description`
NEW_DOCS="docs/new.md" bun frontmatter-check.ts docs/new.md

# no args: scan the whole tree
DOCS_DIR=docs bun frontmatter-check.ts
```

Wire it into a pre-commit hook over staged `docs/**/*.md` for fast feedback and
into CI as the authority (compute `NEW_DOCS` from the PR's added files). See
[`../../mappings.md`](../../mappings.md).

## Files

| File | Role |
|------|------|
| `frontmatter-check.ts` | the checker; reads enums/required/tags from the schema |
| `frontmatter-check.test.ts` | paired self-test |
| `fixtures/schema.yaml` | a copy of the template schema for the self-test |
| `fixtures/good/` | valid docs (architecture, ADR, no-description) — must pass |
| `fixtures/bad/` | bad enums/date/tags, ADR missing fields, no frontmatter — must fail |

Run the self-test any time with `bun test frontmatter-check.test.ts`.

## The stale-`last_updated` gate (future/strict)

A diff-aware gate completes the picture: if a doc's *body* changes,
`last_updated` must advance in the same diff. That needs the diff, not just the
file, so it lives in CI wiring rather than this file check — the Strict-level
criterion in [`../../maturity.yaml`](../../maturity.yaml) names it. Sketch:
parse the diff's hunk headers, and if any changed line falls outside the
frontmatter block, require the `last_updated:` line to have been added/advanced
(or already equal today).
