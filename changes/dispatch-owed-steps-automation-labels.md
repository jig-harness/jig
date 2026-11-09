---
release: minor
---

### Added

- Dispatch labels: `jig:followup-failed` marks a merged pull request whose follow-up failed and waits for a person; a later follow-up that is done replaces it with `jig:followed-up`. With the dispatch labels on, the dispatcher also keeps marker labels on the pull requests it reads: the repository's manual-operations label (`issue_tracker.labels.manual_ops`, `manual-ops` by default) on a pull request whose `## Out-of-tree follow-ups` section lists a step not yet checked off, kept after the merge until the follow-up is done; and `automation` on a pull request a bot opened that carries no `automation:` label, unless the bot is one the adoption rule names (the host's own identity). Create the new labels with `jig install dispatch --repo <path> --yes`, which lists the ones the signed-in account may not create; until they exist, the dispatcher reports each refused write and tries again at the next run ([CONFIGURATION.md](../plugin/CONFIGURATION.md#dispatch)).
- The audit's `config-fit` suggests labelling the workflow steps that open pull requests (`peter-evans/create-pull-request`, `gh pr create`) with an `automation:` label (`suggestion:automation-labels`).

### Changed

- The dispatcher drives an automation pull request (a bot's that `dispatch.adopt.authors` does not name, or one carrying `automation` or an `automation:` label) only while it needs work: a check on its head failed (a run cancelled on a superseded head, or one waiting for approval, is no failure), it conflicts with its base, or a review thread is unresolved. That holds for the adoption rule and for the re-drives, takeovers and re-arms the dispatcher starts of itself, such as a converged drive whose head moved. A healthy one is left for a person to merge; `jig:drive` or `jig:rearm` still starts one on request. A bot the adoption rule names is the host's own identity: its pull requests are adopted as before unless they carry an automation label.
- **Breaking:** `dispatch.labels.prefix` takes at most 35 characters (39 before), so every label of the set, `followup-failed` the longest, fits the forge's 50. A repository whose prefix is longer must shorten it to at most 35 characters in its `.config/jig.yaml` on the default branch before upgrading, or the dispatcher refuses its `dispatch` section.
- The dispatcher's repository query reads each open pull request's description, its head's checks and its review threads, which costs two points of the forge's GraphQL budget per page of 50 pull requests instead of one.
