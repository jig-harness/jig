# Sticky date stamping for generators

A generator that writes documents into a governed docs tree (an index, an
[orphan report](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), a roster) has to set their `last_updated` date, and both
obvious ways to do it break something:

- **Never advancing the date** breaks the
  [stale `last_updated` gate](../stale-last-updated/): the generated body
  changes, the date does not, and the gate fails on whichever pull request
  happens to regenerate the file next, not on the change that caused it.
- **Advancing it on every run** rewrites files whose only change is the date:
  a hook re-stages them on unrelated commits, and a freshness check
  (`--check`) fails whenever a day boundary passes between generation and
  check.

[`frontmatter-stamp.ts`](frontmatter-stamp.ts) implements the contract between
the two, called *sticky stamping* ([glossary](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)):

1. Render the document with today's date.
2. Compare it with the file already on disk, with only the frontmatter
   `last_updated:` line set aside. Everything else, other frontmatter
   included, counts: a hand edit to a generated file's `owner:` is drift that
   the next generation overwrites, so it must show.
3. Same content: keep the existing date. Different content, or no file yet:
   use today.
4. Today is the UTC date, the one the stale gate compares against, so a
   generator run in a local evening does not stamp a date CI calls tomorrow.

| Function | Does |
| --- | --- |
| `utcToday(now?)` | today's date in UTC, `YYYY-MM-DD` |
| `stickyDate(existing, fresh, today?)` | the date to stamp: the existing one when only the date differs, today otherwise |
| `stampLastUpdated(content, date)` | sets `last_updated:` inside the leading frontmatter only, never a line in the body; throws when frontmatter is present but never closes or the shared reader reports an error in it, whether or not it has a `last_updated:` line, or when the value continues past its key line (a block scalar), which a one-line stamp cannot replace whole |
| `normalizeLastUpdated(content)` | the content with the frontmatter date set aside, for comparison |
| `extractLastUpdated(content)` | the frontmatter date as the shared reader reads it, or null |

[`../index/generate-index.ts`](../index/generate-index.ts) uses it for its
orphan report. The paired self-test is
[`frontmatter-stamp.test.ts`](https://github.com/jig-harness/jig/blob/main/plugin/skills/docs/__tests__/frontmatter-stamp.test.ts), in
the skill's `__tests__/`.
