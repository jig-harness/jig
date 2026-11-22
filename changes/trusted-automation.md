---
release: minor
---

### Added

- `pull_requests.trusted_automation` names the bots, such as Renovate and
  Dependabot, whose converged pull requests count as the repository's own
  for the Ready predicate, so they reach merge now instead of approve
  first. A listed bot's pull request qualifies only when its head is in the
  repository, every commit is the bot's own or a listed committer's, each signed for
  the account it names unless the entry says `signed: false`, every changed file is within the entry's paths (by default
  `package.json` and the JavaScript lockfiles), and, where the entry sets
  `update_types`, its manifest diff shows an allowed update type. Any fact
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
