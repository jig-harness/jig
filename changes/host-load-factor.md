---
release: minor
---

### Added

- The dispatcher measures its host each tick and reports its load factor.
  Under the act lock it reads the host's gauges: memory, the one-minute load per
  core, the test lock's holders and waiters, free disk on the workspaces'
  filesystems, the forge's budget and the accounts' free slots. Every
  receipt, the dashboard's line and the top of the Running view carry each
  gauge, the load factor as the fullest gauge's fill against its line
  ("82% · memory binds") and the launches the load factor would hold. A
  launch fits while every gauge stays under its line with its kind's memory
  reservation counted, and a pickup also keeps room for a drive or
  follow-up after it. On Linux each kind's reservation becomes the 90th
  percentile of its last 20 measured sessions once it has 5. The
  `load:` section of `~/.jig/dispatch.yaml` sets the lines and default
  reservations ([CONFIGURATION.md](../plugin/CONFIGURATION.md)). It ships
  with `load.enforce: false`, so a launch a gauge refuses still starts and
  is reported; a person turns enforcement on after a week of receipts.
- A run waiting on the machine-wide resource lock announces itself beside
  the lock until it holds a slot or gives up, so another mechanism can count
  the waiters ([M12](../modules/M12-parallel-agent-ergonomics/README.md)).
