---
release: patch
---

### Fixed

- On a host whose `gh` picks its account by the repository's owner (a
  wrapper first on `PATH`, for a host that works for two forge accounts),
  the GitHub tracker read a private repository of the second owner as
  `NOT_FOUND`, so that repository's tracker record failed on every dispatcher
  tick. Each `gh api graphql` run of the GitHub tracker and the GitHub
  reflection store now names the repository its request is about in
  `GH_REPO`: the one its variables name, else the tracker's or the store's
  own repository.
  The dispatcher's merge-facts read and its count of a pull request's
  unresolved review threads name theirs too. The HTTPS transport
  (`JIG_GITHUB_GRAPHQL_URL`) is unchanged.
