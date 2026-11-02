---
release: patch
---

### Added

- A map of Jig by mechanism, [plugin/MECHANISMS.md](../plugin/MECHANISMS.md),
  on the site as "Where the model is in the loop": for each part of the
  plugin (the gates, the `jig` command and its timers, resource collection,
  the dispatcher and its records, the follow-up marker, the drive, review,
  the tracker and forge scripts, pickup, the changelog and release, hooks,
  the audit) it names the script that owns it, where its state lives and
  what it refuses, the model sessions that use it and what they decide
  there, and who notices a failure and who is asked to fix it. It also says
  when a model reads or writes Jig's own code, and which boundaries rest on
  instructions rather than on a check. The glossary defines
  deterministic and reasoned parts.
