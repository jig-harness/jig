---
release: minor
---

### Added

- `jig install dispatch --env NAME` (and `jig dispatch install --env NAME`),
  repeatable, writes the named variable's value from the installing shell
  into the dispatcher's launchd jobs on macOS, so a tracker credential or a
  notification channel's address reaches the scheduled tick. It takes a name
  only, never `NAME=VALUE`, and refuses a variable that is unset or empty
  before it writes anything. Elsewhere it is refused with the systemd
  drop-in to use instead.

### Fixed

- Reinstalling a launchd job with `jig install` no longer drops the
  variables a person added to its `EnvironmentVariables`: the install keeps
  every variable it does not write itself and refreshes its own. The
  preview names the variables it keeps or captures and never shows their
  values.
