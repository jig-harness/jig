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
  path allowlist. Every changed `package.json`, those included, must show at
  least one classifiable change to an existing dependency's version or
  range, with no edit outside the recognized dependency-line shape, no
  unclassifiable version change and no dependency added or removed; a
  formatting-only edit to one manifest withholds the exception for the whole
  pull request. Only the textual patch is read, so the operator reviews
  what it cannot see: file modes are not compared, top-level dependency
  section names and keys must be unique because a duplicate's effective
  value cannot be determined, and a moved or copied manifest needs review of
  the effective install configuration at both locations and of the
  destination's whole contents, since unchanged fields such as
  `packageManager` can change their effect. For every entry, a bare login
  included, the operator reviews what the install consumes before the
  pull request reaches the drive host, which installs during a base merge or
  conflict resolution, before the Ready decision: for each affected
  directory, the lockfile consumed (npm 11 prefers `npm-shrinkwrap.json`,
  npm 12 ignores it, Jig prefers `package-lock.json`) and, for a
  manifest-only edit such as `packageManager`, the contents of a newly
  selected lockfile; the installer's full version and source; the command
  (`drive.dependency_install` is chosen by Jig's detected lockfile name);
  installer configuration files such as `.yarnrc.yml`, which schedule no
  install on their own; and a lockfile or frozen install that disappears.
  [The configuration guide](../plugin/CONFIGURATION.md) lists each check.
  An entry without `update_types` skips manifest
  classification, so such an edit can still qualify; with `update_types` set,
  a direct top-level `packageManager` edit withholds the exception. Two-space and one-tab layouts are
  supported; a layout whose root dependency section opener reads as nested
  (such as four-space indentation), or unchanged context outside the
  patch grammar (such as an inline array), withholds the exception, which
  does not by itself decide the pull request's placement.
  A rename or copy the forge reports to a
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
  **Consumer action:** advised at instructions. Review a trusted-automation
  pull request's install inputs as the configuration guide says, before the
  drive host installs. **Detect:** `config:pull_requests.trusted_automation`.
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
