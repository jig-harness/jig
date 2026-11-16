---
release: minor
---

### Added

- The [followup](../plugin/skills/followup/README.md) skill (`/jig:followup`) runs the post-merge stage in any repository: after a merge it settles each class of obligation the merge can leave (the tracker item and epic, deferred review findings, out-of-tree steps, the release and its tags, temporary scaffolding and live drivers, live verification, the next step, and the workspace card in Orca) with one verdict and its evidence, carries out what its fixed authority table allows and files the rest; on an open pull request it previews what the merge will owe. Its script keeps the protocol the dispatcher expects: the claim checked before every outside write, and no run ended while an arm has no verdict. Name it in `dispatch.followup_command` to have the dispatcher start it after each merge.
- The configuration fields `followup.off` (core arms a repository does not run) and `followup.authority` (acts moved to a stricter level; a looser one is refused), documented in [CONFIGURATION.md](../plugin/CONFIGURATION.md#followup).
