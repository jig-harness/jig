# Regex-mirror guard — keep a hand-written CI shortcut honest

Running the full change-area resolver on every CI event can be overkill when
all a workflow needs is a fast "did any *code* change?" boolean (e.g. to decide
whether to run the heavy build at all). Teams answer that with a hand-written
alternation regex over path prefixes — `^apps/|^packages/|^tools/ci/`. That
regex is a **second copy** of part of the [catalog](../catalog/), and second
copies drift: the regex says "code changed" but the resolver skips the matching
gates, or a new code path is added to an area but the shortcut still treats it
as docs-only and lets a stale marker through.

The fix is to mechanically check the regex and the catalog against each other
**in both directions**. Neither can gain or lose a code-bearing path without
the other, or CI fails.

## Direction 1 — regex → catalog (runnable here)

[`check-catalog-regex-sync.sh`](check-catalog-regex-sync.sh) reads the
alternation regex out of the filter script, splits it on `|`, normalizes each
segment to a plain path prefix (strips `^`, `$`, trailing `.*` / `/**` / `/`,
backslash escapes), and asserts each prefix appears as a literal substring in
the catalog. A prefix the regex knows about but the catalog doesn't = drift.

```sh
FILTER_FILE=tools/ci/detect-changes-filter.sh \
CATALOG=tools/change-areas/catalog.yaml \
  ./check-catalog-regex-sync.sh
```

Inputs come from env vars so the paired self-test
([`test-catalog-regex-sync.sh`](test-catalog-regex-sync.sh)) can point the gate
at the [`fixtures/`](fixtures/): a `synced/` pair that must pass and a `drift/`
pair (regex has a `^services/` prefix no area covers) that must fail. Run the
self-test any time with `./test-catalog-regex-sync.sh`; CI runs it too, so a
broken gate fails loudly instead of passing green.

## Direction 2 — catalog → regex (recipe)

The reverse check needs the resolver's `impliedBy` closure, so it lives with
the resolver rather than as a standalone shell script:

1. For each area, decide if it is **code-bearing** — its forward `impliedBy`
   closure reaches any area you designate as "code" (the areas whose change
   means the heavy build must run).
2. For each code-bearing area's `paths` glob, synthesize a concrete test path
   (replace `**`/`*` with a literal token: `apps/web-app/**` → `apps/web-app/x`).
3. Assert the regex matches that path. A code-bearing path the regex misses is
   drift — the shortcut would classify that commit as docs-only.

Together the two directions form a closed loop: the fast regex and the catalog
are provably the same set of code-bearing prefixes, checked on every PR.

## When you don't need this

If you don't keep a hand-written CI shortcut — every job selection goes through
the resolver — there is no second copy to keep honest and this guard is
unnecessary. It exists only to make an *optimization* safe, not as a required
part of the catalog itself.
