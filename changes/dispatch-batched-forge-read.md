---
release: minor
---

### Changed

- `jig dispatch` reads each repository in one GraphQL query per tick: the
  repository and its default branch, the dispatch configuration on that
  branch, and the open pull requests with their labels, heads,
  mergeability and comments, 50 pull requests to a page at one point of
  the forge's GraphQL budget each. It replaces the repository view, the
  configuration file read, the pull request listing and one comment
  listing per open pull request, so a sweep of many repositories makes a
  few calls per repository instead of one per pull request. A pull request
  with more than 100 comments is listed on its own, in full. The merges
  whose follow-up markers a tick reads again have their comments read in
  one query too, 50 to a page. Where a query fails, the tick reads each of
  these on its own as before. The reads just
  before a launch, a claim or an end still go to the forge one by one. The
  forge record says how the open pull requests were read, and what the
  query cost.
