---
release: minor
---

### Added

- `dispatch.followup_routine` chooses which routine question classes
  (`local-leftover`, `person-owed`, `drafted-items`; every class by default) a
  follow-up settles unattended. A class left out is not offered to the pass,
  and a question of that class goes to a person like any other, so a
  repository that files into a shared tracker can turn `drafted-items` off.
  An unknown class is refused by the configuration check.

### Fixed

- A merged pull request's follow-up that waited because a workspace held
  terminals the runtime cannot report (an idle shell or an editor) sat off
  the line indefinitely. It now appears as a need that names the workspace
  and says to close the terminals that run no agent; a follow-up beside an
  agent the runtime reports working still waits.
- A Codex follow-up, steward or pickup pass that stops within its first
  minute without starting a session is now treated like a Claude Code one
  that could not start: its account backs off and the follow-up is retried
  instead of waiting for a person. A Codex pass that started work and then
  failed still counts as a pass that died.
- When a release adds a dispatch label a repository does not have yet, the
  dispatcher creates it and writes the pull request's label in the same
  tick. If the signed-in account may not create labels, a person is told
  once for the repository, with the command that creates the label, instead
  of once per pull request.
