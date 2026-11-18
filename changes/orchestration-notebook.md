---
release: minor
---

### Added

- `/jig:orchestrate` keeps each topic's record in an orchestration notebook,
  `~/.jig/orchestrate/<topic>/` (under `JIG_HOME` when set), outside every
  repository and the same for Claude Code and Codex: `state.md`, the current
  state with the decisions waiting on you and the acts owed, rewritten whole
  at each change, and `journal/<date>.md`, an append-only log of decisions
  and their reasons. A session started with `/jig:orchestrate <topic>` resumes
  from the state alone, and a handover hands the successor just the topic.
