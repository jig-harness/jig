---
release: patch
---

### Added

- [M14](../modules/M14-testing-strategy/README.md) ships a fixed-delay gate,
  [`reference/fixed-delay/`](../modules/M14-testing-strategy/reference/fixed-delay/README.md):
  it fails a fixed delay (by default `Bun.sleep(`, `setTimeout(`, `sleep(`
  and `time.sleep(`; `--pattern` names others) without a
  `fixed-delay: <reason>` token on its line or the line above, a token
  without a reason, and a token with no delay on its line or the line below.
  It has no imports beyond Bun's and Node's built-ins, so it can be copied as
  it is.

### Changed

- M14's tests-with-changes gate fails an exemption whose glob matches no file
  in the tree it reads (`HEAD` with `--base`, the `--root` tree with
  `--changed`), with exit 1 and the line to delete, whatever the change
  touched. A repository whose exemptions file still holds a line for deleted
  code sees that line fail on its next change; an exemption whose only file a
  change deletes fails in that change.
- The audit's M14 criteria `tests-come-with-changes` and
  `fixed-sleeps-banned` now look for those two prunings: a check that passes
  an exemption matching no file, or a token with no delay beside it, no
  longer scores `mechanical` on them.
