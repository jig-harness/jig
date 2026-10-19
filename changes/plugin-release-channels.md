---
release: minor
---

### Added

- **Release channels for the plugin.** Machines now install `jig` from a
  channel: `stable`, which receives a version once it has spent 72 hours on
  `latest` with its gates green and no open regression, or `latest`, which
  receives every version once it is tagged. Install with
  `claude plugin install jig --marketplace https://github.com/jig-harness/jig.git#stable`
  or `codex plugin marketplace add https://github.com/jig-harness/jig.git --ref stable`;
  `bun tools/plugin/setup.ts` follows `stable` on a fresh machine and takes
  `--channel latest|stable`. A channel holds the plugin without its tests
  and development notes, so the install is smaller. A machine added without
  a ref still follows `main`, which receives each version before its gates
  pass; to move it to a channel, remove the marketplace and add it again at
  the channel, as
  [Release channels](../plugin/README.md#release-channels) shows. The plugin's
  id stays `jig@jig`, so repositories need no change.
