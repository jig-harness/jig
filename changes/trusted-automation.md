---
release: minor
---

### Added

- `pull_requests.trusted_automation` names the bots, such as Renovate and
  Dependabot, whose converged pull requests count as the repository's own
  for the Ready predicate, so they reach merge now instead of approve
  first. A listed bot's pull request qualifies only when its head is in the
  repository, every commit is the bot's own or a listed committer's, each signed for
  the account it names unless the entry says `signed: false`, every
  changed file, and the original path of a reported rename or copy, is
  within the entry's paths (by default
  `package.json` and the JavaScript lockfiles). Where the entry sets
  `update_types`, every dependency edit must be covered by the allowed
  types, and only a `package.json` is classified, by its dependency diff.
  A rename or copy the forge reports for a `package.json` must pass the
  path allowlist, and its destination's diff must show at least one
  classifiable change to an existing dependency's version or range, with no
  unrelated textual edit and no dependency added or removed. Only the
  textual patch is read: file modes and duplicate dependency keys are not
  compared, and a layout that nests the root dependency section's opener
  (such as four-space indentation) stays in approve first. A rename or copy the forge reports to a
  recognized lockfile needs a recognized lockfile name at its original
  path; a copy the forge reports as a plain addition has no original name
  and is judged on its destination alone. Any other destination is
  refused. A lockfile may accompany a classified `package.json` update
  without `lockfile` being listed; `lockfile` is needed only when
  lockfiles alone change. The Ready predicate does not validate lockfile
  contents, whether a lockfile accompanies a manifest update or is the only
  change, and does not check it against the manifest. The refusals are in
  [Trusted automation](../plugin/CONFIGURATION.md#trusted-automation) in
  the configuration guide. Any fact
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
