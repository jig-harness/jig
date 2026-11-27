---
release: patch
---

### Fixed

- The dispatcher's board, the merge-ready announcement and `jig ask` now
  follow a pull request's labels, review threads, review requests and
  latest reviews past their first page, up to three pages each under the
  read's deadline, as they already follow check contexts. A pull request
  with more than 100 review threads (a long drive with an AI reviewer) no
  longer stays partial while it is open: it is placed on all of its
  threads, and an unresolved thread on a later page keeps it out of Ready to
  merge with the count named. Past the cap, on a moved head or past the
  deadline the card stays partial and names the connection and the reason.
