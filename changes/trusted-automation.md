---
release: minor
---

### Added

- `pull_requests.trusted_automation` names the bots, such as Renovate and
  Dependabot, whose converged pull requests count as the repository's own
  for the Ready predicate, so they reach merge now instead of approve
  first. A listed bot's pull request qualifies only when its head is in the
  repository, every commit is the bot's own or a listed committer's, each signed for
  the account it names unless the entry says `signed: false`, every changed file, and the original path of a reported rename or copy, is within the entry's paths (by default
  `package.json` and the JavaScript lockfiles), and, where the entry sets
  `update_types`, a reported rename or copy whose new path is a recognized lockfile needs a recognized lockfile name at its original path too, and every dependency edit is covered by the allowed types, where a `package.json` is classified by its dependency diff and a rename or copy of a manifest is governed by the path allowlist alone (a recognized lockfile may accompany a classified `package.json` update without `lockfile` being listed, and its contents are not checked against that manifest; `lockfile` is needed only when lockfiles alone change). Any fact
  that does not read withholds the exception, and the card's fact names
  the rule. The list is read from the default branch by the board, `jig
ask` and the drive's merge-ready announcement, never from the pull
  request's own configuration, and the announcement takes the reviewer app,
  its check pattern and both hold labels from there too for a listed bot. Where no reviewer app is named, a
  person's approval is the witness and the exception grants nothing. A person still merges.
- With `dispatch.adopt` on, a listed bot's pull request whose head is
  known to be in the repository and that was updated within the adoption
  window, with no hold, is adopted and driven to convergence while healthy,
  and again when its head moves, whether or not `dispatch.adopt.authors`
  names the bot.

### Changed

- The placement table now treats a failing required check as a failure that
  overrides a clean merge state, names required failures first and lists
  other failing checks apart. These changes apply
  to every pull request, not only trusted automation's.
