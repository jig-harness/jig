---
release: minor
---

### Changed

- The dispatch dashboard (`jig dispatch dashboard`) has one view per
  question, each a single column of cards with its count on its tab:
  **Merge**, **Needs you**, **Running**, **Queue** and **History**, then
  Help. Merge shows Ready to merge's three lanes (merge now, approve first,
  update next), each merge now card with its merge command pinned to the
  head the drive verified. The page opens on Merge while merge now holds a
  pull request, else on Needs you, and while merge now holds one every
  other view says so at its top until it is dismissed, which lasts until a
  pull request reaches merge now at a new head. An address that names the
  old Now view opens Needs you.

### Added

- Keys on the dispatch dashboard: j and k move between cards, Enter or o
  opens one, p and i open its pull request or issue, c copies its command,
  g then m, n, r, q or h goes to a view, / filters the view and ? lists the
  keys. ⌘K or Ctrl-K opens a palette that goes to a view, jumps to `#N` or
  an item, or copies a card's command. No key fires while you type in a
  field, and Tab still reaches every control.
