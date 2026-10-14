# Generated docs index + freshness gate

Navigation is generated, never hand-curated — otherwise it rots the moment a
doc is added or renamed, and a stale index is worse than none because people
trust it. [`generate-index.ts`](generate-index.ts) walks the docs tree, reads
each doc's frontmatter `title`/`description` (falling back to a humanized
filename), groups by top-level folder, and emits a sorted `INDEX.md`.

It also writes an **orphan report**, `.orphans.md` beside the index: the
documents no other document lists in its `related:` frontmatter field
([orphan documents](../../../../GLOSSARY.md)).

This is [M2](../../../M2-generated-artifact-freshness/)'s **freshness triad**
applied to navigation:

1. **Regenerate script**: `generate-index.ts` writes `INDEX.md` and
   `.orphans.md`.
2. **Drift gate**: `generate-index.ts --check` generates both in memory and
   compares them with the committed files, failing when either is stale and
   naming each stale one. Wire this into CI as the authority.
3. **Auto-stage hook**: a pre-commit hook that runs the generator and stages
   both files when any doc changes, so local commits go out fresh (see
   [`../../mappings.md`](../../mappings.md) and M2's lefthook/husky wiring).

```sh
DOCS_DIR=docs bun generate-index.ts          # regenerate
DOCS_DIR=docs bun generate-index.ts --check  # CI drift gate; exit 1 if stale
```

`DOCS_DIR` defaults to `docs`; `OUT` names the index file (default
`$DOCS_DIR/INDEX.md`) and `ORPHANS` the orphan report (default
`$DOCS_DIR/.orphans.md`). These two files, and no others, are left out of
the index and the orphan count: a nested `guides/INDEX.md` is an ordinary
document. A title or description is written as one table cell, its line
breaks folded into spaces and `|` escaped. A missing docs directory, a doc
whose frontmatter is present but outside the [YAML subset](../frontmatter-check/README.md#supported-yaml-subset)
(the generator does not guess from a partial reading), `OUT` and `ORPHANS`
naming the same file, or an argument other than `--check` exits 2.

The script uses the shared [`../docs.ts`](../docs.ts) reader and
[`../stamp/`](../stamp/). When adopting these files, keep both beside it in
the parent directory and run them with Bun.

## Determinism

The generator is order-stable (byte-order sorting on the row set), so the same
tree always produces byte-identical output: a freshness gate is only
meaningful if regeneration is deterministic. `INDEX.md` carries no date. The
orphan report carries frontmatter, so it fits the docs schema like any other
document, and its `last_updated` is stamped with the
[sticky date](../stamp/): it advances only when the report's content changes,
so `--check` gives the same answer on any day.

## Orphan report

An *orphan* is a document no other document lists under `related:` in its
frontmatter. Ordinary Markdown links in a body are not read, so an orphan may
still be linked from another page: the report shows missing declared
relations, not missing navigation, and each entry is a candidate for a
`related:` entry or for retiring. Orphans are a warning, never a failure: they
are a health signal, not a build break. `--check` fails when either generated
file (`INDEX.md` or `.orphans.md`) is stale, never because orphans exist.

- `related:` is read through the shared reader, as an inline list
  (`related: [../a.md]`) or a block list (one `- ../a.md` line per entry).
- Each entry resolves relative to the document that lists it. An entry
  starting with `/` resolves from the repository root, as a link does on a
  forge, so `/docs/guides/a.md` names `guides/a.md` in a `docs/` tree. The
  root is the nearest directory above the docs tree that holds `.git` (else
  the working directory); `REPO_ROOT` sets it. An entry pointing outside the
  docs tree, or a `#section` suffix, is ignored.
- A document that lists only itself is still an orphan.
- The list is sorted by byte order. Each entry is named by its docs-relative
  path and linked relative to the report's own directory, wherever `ORPHANS`
  puts it.

The generator prints `WARN — N orphaned doc(s)` when the report is not empty.

The report's frontmatter defaults (`type: reference`, `status: active`,
`lifecycle: temporary`, `owner: docs`, `tags: [navigation]`) match the M4
template schema, so the frontmatter check passes it. A repository with a
different vocabulary sets its own values with `ORPHANS_TYPE`,
`ORPHANS_STATUS`, `ORPHANS_LIFECYCLE`, `ORPHANS_OWNER` and `ORPHANS_TAGS`
(the tags as an inline list, `[a, b]`).

## Files

| File | Role |
|------|------|
| `generate-index.ts` | the generator + `--check` freshness gate |
| `generate-index.test.ts` | paired self-test: the fixture index and orphan report reproduce exactly whatever the date, an added doc makes `--check` fail, a hand edit to the report is drift, `related:` resolves in both list forms, report links resolve from the report's directory, a multi-line description stays one row, a nested `INDEX.md` is a document, and unreadable frontmatter, an unknown argument or one file named twice exits 2 |
| `fixtures/docs/` | a small tree (nested folders, a no-frontmatter doc, inline and block `related:` lists) with its committed `INDEX.md` and `.orphans.md` |

Run the self-test with `bun test generate-index.test.ts`.
