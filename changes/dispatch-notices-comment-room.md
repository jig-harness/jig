---
release: patch
---

### Fixed

- A repository's notices comment that reached its 16,000-character limit no
  longer holds back every later notice: the entries whose causes are settled
  (the pull request closed, the need answered) leave a comment only the
  dispatcher wrote to make room, and an entry whose cause still stands is
  never dropped. A notice that still finds no room counts as a failed
  delivery, so past `failures.notify_after` ticks a person is told through
  whatever destination still delivers. `jig ask` and the dashboard say which
  notices were held and why, and a notices workspace is counted as written
  only on a tick that wrote it, so one whose causes are all gone is retired.
