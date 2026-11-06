---
release: minor
---

### Changed

- The dispatcher sends every notification for a repository to one place: the repository's notices workspace, or the workspace on the branch the new `dispatch.notices_branch` setting names. It no longer writes a notice into the workspace joined to the pull request or item, such as an agent's tree or a follow-up's workspace, which a person following many repositories does not visit. Each message now names the workspace the stage ran in, where its handoff is ([CONFIGURATION.md](../plugin/CONFIGURATION.md#dispatch)).
- A notification whose cause still stands is sent again after `dispatch.renotify_after` (a day by default), saying since when it has waited, until the cause goes, rather than once per cause for good. `0s` keeps the old behaviour of sending each one once.

### Added

- The dispatch dashboard's What needs you shows the question a follow-up stopped on, and the workspace each notice was sent to.

### Fixed

- A follow-up claim that no run will finish no longer holds the follow-up for good. A marker a person's run posted and never marked done, or another host's with no answer, that is older than the new `dispatch.followup_stale_after` (a day by default) with no session joined to its pull request is released once: the dispatcher deletes it and starts the follow-up again at its next run, and the report says whose claim it was. A claim on the same pull request that goes stale again is notified to a person instead of released a second time.

- Pending stale-claim releases survive a lost deletion response and are completed from the next full marker listing, including their outcome event, before a follow-up can start again. Release-history reads use only the pull requests being classified. Named notification destinations preserve personal comments even when an agent has run there, and stale tick-marker notices name the result command instead of the manual-marker command.
