---
release: minor
---

### Added

- A drive's terminal tab in Orca now closes itself when the drive ends with
  nothing for a person: converged, merged or closed, taken over, re-armable,
  stopped or paused by a person, or refused because another driver holds the
  pull request. This covers a drive `drive-pr` or `do-item` arms in a tab and
  a stage the dispatcher launches (a dispatcher session closes its tab once it
  records `done`). A drive that parks or fails keeps its tab for you, and the
  next run for the same pull request or item closes that earlier terminal if
  nothing is running in it. Only the recorded terminal closes, never a pane
  you added beside it. What the tab showed stays in the driver log, the ledger and the
  pass's session transcript. Only tabs Jig opened and recorded are closed
  (see *run tab* in [GLOSSARY.md](../GLOSSARY.md)); a tab you opened, and a
  run tab opened before this release, is never touched.
