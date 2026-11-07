---
release: minor
---

### Changed

- `jig dispatch` reads every repository at once, then acts on them one at a
  time. The read phase keeps at most six reads in flight, and reads a
  repository's tracker and forge side by side. The act phase plans, launches
  and writes labels for each repository in turn, in the same rotated order
  as before, so the same launches are admitted. On a host with eleven
  repositories, a sweep that took about 42 seconds now takes about 8.
- A tick for one repository (the Orca plugin's wake-up, or `jig send`'s) no
  longer waits for a full sweep's reads. Each repository is read and acted on
  under its own lock (`~/.local/state/jig/dispatch/observe/`), and acting is
  under `tick.lock`, the lock earlier versions take for their whole run, so a
  tick of this version and one of an earlier version never act at once. A
  tick waits up to two minutes for another tick's act phase, and leaves a
  repository another tick is reading to that tick, listing it under `busy` on
  its receipt. Two checkouts of one repository count as one repository.
- The forge's rate limit is now read once, as the tick starts. While less
  than a tenth of it is left, the tick skips the running drives' thread
  samples and serialization's reads. Without serialization's reads, no
  re-arm starts in a repository with a change-area catalog for that tick. The
  receipt lists what was skipped (`lowBudget`). A receipt's tick phases are
  now `start`, `observe`, `wait`, `act` and `close`.
