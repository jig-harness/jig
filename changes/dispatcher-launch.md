---
release: minor
---

### Added

- `jig dispatch --apply` restarts stopped drives without a person: each
  re-arm of a drive stopped on a usage limit or an answered park, and each
  takeover of a wedged driver the machine started, runs in a terminal tab
  of the pull request's Orca workspace (opened from the pull request when
  none holds it), billed to an account the new machine file
  (`~/.jig/dispatch.yaml`) lists, within that account's cap and outside
  any usage-limit wall it recorded. A launch record written before each
  launch keeps a lost answer from starting a second pass, and a refusal
  `drive.ts` gives is not fought. See the plugin README's "The dispatcher"
  and CONFIGURATION.md's "The machine's dispatch file".
- `jig dispatch install [--interval 5m] [--yes] [--uninstall]` previews and
  writes the timer that runs `jig dispatch --apply`, on the same scheduler
  code as `jig gc install`.
