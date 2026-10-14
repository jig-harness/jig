# Stale `last_updated` gate

A document's `last_updated` date is only useful if it moves when the document
does. Without a check, people edit a page and forget the date, and the date
then says the page has not changed in a year when it changed last week, or the
reverse: readers and agents cannot tell a current page from a stale one.
[`stale-last-updated.ts`](stale-last-updated.ts) makes the date honest.

## The rule

If a diff changes a document's body (any line after the
[frontmatter](../../../../GLOSSARY.md)'s closing `---`), the same diff must
either

- **advance** `last_updated`: the new date is a calendar date, written
  `YYYY-MM-DD`, later than the old one, or the old side had none; or
- leave a `last_updated` that **already equals today** in UTC, because an
  earlier commit the same day advanced it.

The check is a comparison of the two sides and their dates, never a judgment
of the change. The details that keep it from being fooled:

- **The sides are compared whole, not through a patch.** The body is
  everything after the frontmatter, compared as text between the old and the
  new content (line endings normalised, so a checkout's CRLF conversion is not
  a change). No patch is parsed, so a file git would show as binary is judged
  like any other.
- **Dates are read by the shared reader**, the same one the frontmatter check
  uses: a body line that starts with `last_updated:` is body, `last_updated :`
  is the field, a trailing comment is cut and quotes come off, so
  `2026-08-01 # note` or `"2026-08-01"` is not later than `2026-08-01`. A
  value that is not a calendar date (`2026-99-99`, `2026-02-30`) never counts
  as advanced.
- **Frontmatter the reader rejects is not read around.** A new side holding
  a construct outside the shared reader's subset (a duplicate
  `last_updated`, an anchor) fails, whether or not the body changed: its date
  cannot be trusted. An old side the reader rejects has no date, so the
  commit that corrects it passes on any calendar date.
- **Only a new file is exempt**: it has no earlier date to advance, and the
  [frontmatter check](../frontmatter-check/) validates its date. A document
  that had no frontmatter on either side has no date to keep. One whose
  frontmatter is removed, or no longer closes, fails: its date cannot be
  checked. Changed documents come from `git diff -z --raw -M`, so a
  renamed document is compared with its old path (a rename plus a body edit
  needs a bump), and a path with spaces or non-ASCII characters is read as
  written. A document that is not a regular file on both sides (replaced by
  a symlink, or a submodule) fails, since it holds no text to compare. Any
  other side that cannot be read is an error (exit 2), never a pass.
- **Today is UTC**, the same date in a local hook and in CI near midnight.

## Modes

| Mode | How | Old side | New side |
| --- | --- | --- | --- |
| Range (CI) | `DIFF_RANGE=origin/main...HEAD` or `--range=<range>` | `A...B`: the merge base of A and B; `A..B` or a single ref: A | the working tree |
| Staged (pre-commit) | `--staged`, or no range given | `HEAD` | the index |
| CI without a range | `--ci` and no range given | — | — |

- **Range mode** diffs the old side against the working tree, so the checkout
  must hold the change being judged. On GitHub Actions a `pull_request`
  checkout is the merge commit of the pull request into its base, not the
  pull request's head; with `origin/<base>...HEAD` the merge base is then the
  base tip, and the diff is exactly what the pull request adds. Fetch enough
  history for the merge base (`fetch-depth: 0`). A range is `A`, `A..B` or
  `A...B`, and both named sides are resolved to commits before use. A ref
  that does not resolve, more than one separator, or a range with no left
  side (`...HEAD`, `..HEAD`) is an error (exit 2), never a comparison of HEAD
  with itself.
- **Staged mode** checks what is being committed, not unstaged edits on top.
  During a merge, a file whose staged content equals one parent's is skipped:
  it carries that branch's content unchanged, and this gate already judged it
  there. A file edited during the merge matches neither parent and is checked.
- **`--ci` with no range given** (`DIFF_RANGE` unset or empty, no `--range=`)
  prints `SKIP — …` and exits 0: the check did not run, and says so rather
  than passing silently. A range that is given but malformed (an unset base
  variable turns `$BASE...HEAD` into `...HEAD`) is an error under `--ci`
  too: a CI job must only set `DIFF_RANGE` where it has a base.
- A range is checked wherever it is supplied, so a malformed `DIFF_RANGE`, or
  one whose refs do not resolve, is an error in staged mode too, and
  `--staged` together with `--range=` is an error rather than a choice
  between them.
- An unknown option, or `--range` without `=<range>`, is an error (exit 2).

With no files named, the gate checks every changed `*.md` file in the diff.
Named files may be relative to the working directory or absolute; the gate
resolves them to repository-relative paths, and a named path outside the
repository is an error.

```sh
DIFF_RANGE=origin/main...HEAD bun stale-last-updated.ts docs/a.md docs/b.md  # CI
bun stale-last-updated.ts --staged                                          # pre-commit
```

`LAST_UPDATED_TODAY` overrides today's date (the self-test uses it). Exit
codes: 0 every changed body has an advanced or current date (or the check was
skipped), 1 at least one has not, 2 git could not resolve the range or read the
repository.

The script uses the shared [`../docs.ts`](../docs.ts) reader. When adopting
these files, keep that helper in the parent directory and run them with Bun.
CI wiring and the hook are in [`../../mappings.md`](../../mappings.md).

## Generated documents

A generator that writes into the docs tree is held to the same rule. It stamps
`last_updated` with the sticky date from [`../stamp/`](../stamp/): advanced
only when its output changed, so it neither breaks this gate on someone
else's pull request nor rewrites files whose only change is the date.

## Files

| File | Role |
| --- | --- |
| `stale-last-updated.ts` | the gate |
| `stale-last-updated.test.ts` | paired self-test: builds throwaway git repositories and runs the gate in them (body edit with and without a bump, body deletion, frontmatter-only edit, fake bumps, a date equal to today, a comment-only "bump", a spaced `last_updated :`, removed or unclosed frontmatter, a body git would call binary, the merge-base side of a triple-dot range, renames, a non-ASCII name, an absolute path, a path outside the repository, one-sided, doubled and unresolvable ranges with and without `--ci`, unknown options, the merge exemption, staged and CI modes) |
