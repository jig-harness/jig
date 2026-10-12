# Prose-facts checks — commit-nothing freshness (rung 2)

Prose sometimes states facts that a script could compute: "12 guides total",
"see `tools/setup.md`". Hand-written, these copies [drift](../../../../GLOSSARY.md)
silently — the count goes stale when a file is added, the path rots when a
file moves — and readers (human or agent) then act on the stale copy.

The obvious fix — generate the fact into a committed include file — trades
one liability for another: every parallel branch that touches the inputs
regenerates the include, and every merge becomes a conflict on the generated
file. The better answer is **rung 2 of the drop > check > commit
ladder** (see the [module README](../../README.md)): a CI job re-derives the
fact *in memory*, compares it to what the prose claims, and fails on
mismatch. **Nothing generated is ever committed** — no cache at rest means
nothing to conflict on, and nothing to go stale.

Two design rules:

- **Flag drift, not presence.** If the prose states no copy of the fact,
  there is nothing to check — dropping the number entirely (rung 1) is the
  preferred outcome, and the check must not punish it.
- **Be conservative in extraction.** Count patterns are anchored to an
  inventory qualifier ("N guides **total**") so incidental prose ("spawn 3
  workers") never matches; path extraction skips URLs, placeholders, globs,
  and bare words. For an advisory check a false negative is acceptable; a
  false positive is not — false positives are how teams learn to ignore a
  gate.

## Files

| File | Role |
|------|------|
| `check-stated-counts.ts` | `<prose-file> <source-dir> <noun>`: fails when a stated count ("N guides total", "available" or "listed") disagrees with the number of Markdown files under the directory, recursively, `index.md` excluded |
| `check-referenced-paths.ts` | `<prose-file>...`: fails when a Markdown link or code-span path in prose resolves to no file. Only references containing a `/` are checked; fenced code is skipped; a link starting with `/` resolves from the repository root, other links from the prose file's directory, and a code-span path from either that directory or the working directory |
| `fixture/` | A tiny instruction file + guides directory both checks pass against |

Both exit 0 when every stated copy agrees, 1 on drift, and 2 on a usage error
or an unreadable input. Their self-tests are in Groundwork's
[`scripts/freshness.test.ts`](../../../../scripts/freshness.test.ts).

Try it with the pinned Bun runtime:

```sh
bun check-stated-counts.ts fixture/instructions.md fixture/guides guides
bun check-referenced-paths.ts fixture/instructions.md
```

To see the failure mode, edit `fixture/instructions.md` to claim "7 guides
total" or point a link at a file that does not exist, and rerun.

## CI wiring and the promotion path

Run both checks on every pull request. A proven adoption path is to land
them **advisory first** (job failure visible but non-blocking), watch for
false positives for a while, then promote to blocking by deleting one line —
no script change needed:

```yaml
- name: Stated-counts drift check (advisory)
  run: bun reference/prose-facts/check-stated-counts.ts <instruction-file> <dir> <noun>
  continue-on-error: true   # delete this line to promote to blocking
```

GitLab CI and hook-manager variants are in
[`../../mappings.md`](../../mappings.md). Run the checkers' self-test (each
checker against a known-bad input, asserting exit 1) as a blocking step even
while the checks themselves are advisory, because a fail-open checker is worse
than no checker.
