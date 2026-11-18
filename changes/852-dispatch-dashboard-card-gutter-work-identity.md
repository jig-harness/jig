---
release: minor
---

### Changed

- The dispatch dashboard's cards open and close from one place: a chevron
  in a fixed column at each card's left, the same on every view, History's
  rows and the tick strip included, or a tap anywhere on the card that is
  not a link, a button or a field. Enter and `o` open the focused card; a
  text selection or a scroll over a card leaves it as it is. The load
  breakdown, the accounts list, the repositories list and Help's folds open
  from the same column. **Consumer action:** none.
- A pull request and an issue are drawn the same way wherever a card names
  them: an icon that opens a popover (title, kind and product, standing,
  repository, linked work and one link out), the number or key as its link,
  and a Copy. A pull request's icon now shows only its standing on the
  forge; where the dispatcher holds it stays with the card's status mark and
  stage chip. **Consumer action:** none.
- The dashboard names each repository's tracker by its product (GitHub
  Issues, Linear, Jira) from the repository's configured adapter, and says
  "issues" where the line does not say; cards no longer repeat "Open the
  pull request" or "Open in the tracker" links their identity already
  gives. **Consumer action:** none.
- The dispatcher's own sentences that the dashboard and `jig dispatch`
  show (holds, waits, refusals and probe answers) name the issue service
  by its product, or say "the issue service" or "issues", instead of
  "tracker". **Consumer action:** none.

### Added

- A card shows the work it is linked to after its identity, from the
  line's links: the issues a pull request closes, or the open pull requests
  that close an issue, up to two and then "+N more". Its popover and the
  opened card list them all, or say "none found" or "not known for this
  read". **Consumer action:** none.
