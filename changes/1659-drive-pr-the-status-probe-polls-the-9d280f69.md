---
release: patch
---

### Fixed

- A waiting pull request status probe backs off when the pull request stays
  unchanged or the shared GitHub GraphQL balance is low. It pauses before
  spending the last of the balance, leaving room for the dispatcher and for
  review rounds, and still respects its wait deadline.
