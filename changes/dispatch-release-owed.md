---
release: patch
---

### Fixed

- A blocked release gets one decision per version in the dispatcher.
  Follow-ups record the owed tag and finish their remaining work. The release
  station refreshes its integration branch before locating the releasing
  commit, and cancels the bounded release-history inspection when the tick
  ends.
