---
release: minor
---

### Changed

- The dispatcher and `drive-pr` reach Claude Code and Codex through one agent-harness interface, with the two as its first implementations in `plugin/shared/agent-harness/` ([ADR-0026](../docs/adr/ADR-0026-the-agent-harness-is-an-interface.md)). A pass's command, its model and effort words, the launch environment, the account's identity, the session id, the transcript, the resume command and the wall readers now come from the harness the account's `vendor` names. Every command a pass or a session runs is the same as before, so nothing changes for a host or a repository.
