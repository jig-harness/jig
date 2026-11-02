---
release: minor
---

### Added

- The Orca workspace card follows the work through the execution line. When
  `drive-pr` marks a pull request Ready, the card moves to In review with the
  pull request linked. When a drive stops on something a person must settle
  (a park, a usage-limit stop, or a failure stop such as a failed reviewer
  check, a stall or a spent round budget), the card is marked unread with
  the stop's one-line reason as its comment, a park's question first, so
  Orca Mobile shows what is waiting. Outside Orca nothing is called, and an
  Orca failure only warns
  ([drive-pr](../plugin/skills/drive-pr/README.md)).
- A card's comment never replaces one a person has not read: while the card
  is unread, a new comment from the board script or a dispatcher
  notification is appended to it, the read and the write held under one
  lock per card; a writer that cannot take the lock within a few seconds
  warns and writes nothing.
- `orca.board` in `.config/jig.yaml` maps the board stages (`in_progress`,
  `in_review`, `completed`) onto a board's custom columns; a repository that
  sets nothing keeps Orca's own columns
  ([CONFIGURATION.md](../plugin/CONFIGURATION.md#orca)).

### Changed

- The board script moved to the plugin's shared code,
  `plugin/shared/orca-board.ts`, and gained `--unread` and `--comment`; with
  either, the stage may be left out. It takes a stage (`in-progress`,
  `in-review` or `completed`) rather than any column id, which `orca.board`
  maps.
