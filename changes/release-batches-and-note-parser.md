---
release: minor
---

Merges that wait for one release run now ship together, change notes are
read by a Markdown parser, and the branch-protection audit combines every
rule that applies to `main`.

### Changed

- The release step releases every waiting change note as one version: the
  largest bump any of them asks for, with all of their notes. A run releases
  the tree it checked out, which already holds the code of every merge that
  landed before it started, so a version numbered and described for the
  earliest merge alone could ship a later breaking change under a patch
  number. [ADR-0002](../docs/adr/ADR-0002-the-plugin-is-its-directory.md) and
  [ADR-0004](../docs/adr/ADR-0004-change-notes-released-after-the-merge.md) are
  amended; `.github/workflows/release.yml` runs the step once.
- Change notes are parsed with Bun's Markdown parser, and a note may hold only
  headings, list items, paragraphs, inline links, code spans and emphasis. A
  code block, raw HTML, quote, table, image or task list is refused wherever
  it sits, not only where a hand-written check expected it. An email address
  is written as `<mailto:…>`, since the parser cannot tell a bare one from a
  relative link the release step would move.
- `scripts/check-branch-protection.ts` reads every page of the rules that
  apply to the branch and combines them with classic protection, as GitHub
  does: a required check or a thread-resolution rule counts whichever
  ruleset holds it. It reports each ruleset's bypass actors with their mode
  instead of one administrator-enforcement flag, and says `unknown` where
  GitHub omits the list. Offline input lists bypass actors under
  `rulesets[]`, and a rule without its ruleset's id or a ruleset with an
  unknown enforcement mode is refused rather than counted as active.
- `/followup` judges whether a merge's release ran by that merge's own notes
  and release run, renamed and edited notes included, so a note a later merge
  added no longer reads as a failed release.

### Fixed

- A change note no longer fails the gate for a code span of three backticks on
  a line of its own, or for `]:` inside a link's title. A note no longer
  passes the gate with a comment opener in a list item that follows an item
  holding a lone pair of backticks, or with raw HTML behind two backslashes.
  Whether text sits in a list item, and which links the release step
  rewrites, is checked against the parser, and a declaration or footnote
  definition is refused only where a renderer would read one, not inside a
  code span. The release step writes a note's links only when the parser
  reads the rewritten text as the original with each relative link moved.
- The release step refuses to write several notes from a shallow clone, whose
  history cannot tell the order they merged in.

### Removed

- **Breaking**: `release.ts` in
  [M12's change-notes reference](../modules/M12-parallel-agent-ergonomics/reference/change-notes/README.md)
  no longer has `--per-merge`, and its `--json` output no longer has
  `remaining`. A caller that looped until none remained runs it once.
