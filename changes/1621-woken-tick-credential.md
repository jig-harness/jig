---
release: patch
---

### Fixed

- A woken dispatcher tick (from `jig send` or the change probe) now runs with
  the command and credential the timer's tick runs with. On systemd the wake
  waiter reads the installed unit as systemd runs it, its drop-ins applied, so
  a drop-in that replaces `ExecStart=` with a wrapper that resolves a tracker
  key gives the woken tick the same key. A drop-in the waiter cannot
  reproduce (an environment file, a credential, a command run first, a
  variable in the command) starts no tick: the waiter's log says why, and the
  request waits for the timer's next tick.
- The timer's sweep (`jig dispatch --apply` over the machine file's
  repositories) waits up to two minutes for a repository a woken tick holds,
  and reads it in the same tick, instead of leaving it out of the sweep on
  every run while wake-ups keep arriving.
