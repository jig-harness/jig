# Generated docs index + freshness gate

Navigation is generated, never hand-curated — otherwise it rots the moment a
doc is added or renamed, and a stale index is worse than none because people
trust it. [`generate-index.ts`](generate-index.ts) walks the docs tree, reads
each doc's frontmatter `title`/`description` (falling back to a humanized
filename), groups by top-level folder, and emits a sorted `INDEX.md`.

This is [M2](../../../M2-generated-artifact-freshness/)'s **freshness triad**
applied to navigation:

1. **Regenerate script** — `generate-index.ts` (writes `INDEX.md`).
2. **Drift gate** — `generate-index.ts --check` regenerates in memory and
   compares against the committed `INDEX.md`, failing when stale. Wire this into
   CI as the authority.
3. **Auto-stage hook** — a pre-commit hook that runs the generator and stages
   `INDEX.md` when any doc changes, so local commits go out fresh (see
   [`../../mappings.md`](../../mappings.md) and M2's lefthook/husky wiring).

```sh
DOCS_DIR=docs bun generate-index.ts          # regenerate
DOCS_DIR=docs bun generate-index.ts --check  # CI drift gate; exit 1 if stale
```

`DOCS_DIR` defaults to `docs`; `OUT` names the index file (default
`$DOCS_DIR/INDEX.md`). A missing docs directory or an unreadable doc exits 2.

The script uses the shared [`../docs.ts`](../docs.ts) reader. When adopting
these files, keep that helper in the parent directory and run them with Bun.

## Determinism

The generator is order-stable (byte-order sorting on the
row set) so the same tree always produces byte-identical output — a freshness
gate is only meaningful if regeneration is deterministic. Keep it that way:
don't stamp the current date into the output, or the index will "drift" every
day. If a generator must carry a date, neutralize date lines on both sides
before comparing.

## Orphan reporting (extension)

An index generator can also build the set of docs referenced by any doc's
`related:` list and report the unreferenced ones as *orphans* (a warning, not
a blocker — see the wiki-lint table in the schema template). This one does
not yet; to add it:
collect every `related:` target across the tree into a set, then list any
`*.md` not in it. Keep it non-blocking; orphans are a health signal, not a
build break.

## Files

| File | Role |
|------|------|
| `generate-index.ts` | the generator + `--check` freshness gate |
| `generate-index.test.ts` | paired self-test: the fixture index reproduces exactly, and an added doc makes `--check` fail |
| `fixtures/docs/` | a small tree (nested folders, a no-frontmatter doc) with its committed `INDEX.md` |

Run the self-test with `bun test generate-index.test.ts`.
