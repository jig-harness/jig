---
release: minor
---

GitHub Issues is now the tracker the skills use when a repository does not choose one; Linear stays one setting away.

### Changed

- **Breaking:** `issue_tracker.adapter` defaults to `github` instead of `linear`. A repository that uses Linear and leaves the adapter out must add `adapter: linear` under `issue_tracker` in `.config/jig.yaml`; until then the skills refuse its configuration, naming the field, rather than reading `issue_tracker.team` and ignoring it. A repository on GitHub Issues needs no `issue_tracker` section at all: the tracker is the `origin` remote's repository, and the skills use the signed-in `gh` client.
- The audit's starter configuration offers `issue_tracker.adapter: linear` along with the team it finds in a repository's history (an empty `adapter:` counts as unset), and its tracker-unreachable finding names GitHub when no adapter is set. The audit probes the tracker of every configured repository, the default one included, by asking whether its team or repository answers rather than reading an issue, and derives a GitHub repository from the audited repository's `origin` remote rather than the working directory's.
- The review skill's deferral step still files through Linear only ([EXTENDING.md](../plugin/EXTENDING.md#issue-tracker) lists what still assumes Linear), so deferring a review finding on the default tracker waits for the roadmap's item 10.
