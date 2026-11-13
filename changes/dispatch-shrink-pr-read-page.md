---
release: patch
---

### Fixed

- The dispatcher reads a repository whose open pull requests carry many
  check results again. GitHub ends a query after ten seconds, so a page of
  50 such pull requests answered HTTP 504 and the repository failed its turn
  on every tick. A page the forge times out (502, 504 or the call's deadline)
  is now asked for again at half its size, down to one pull request, and the
  size that answered is kept in the dispatch state for a day, so the next
  tick begins there. Where the query still does not read, the pull request
  listing reads the checks in a query of their own, in pages of that size,
  and a forge record that fails names the query's failure beside the
  listing's. **Consumer action:** none.
