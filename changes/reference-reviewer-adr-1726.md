### Changed

- [M7](../modules/M7-pr-lifecycle-review/README.md) no longer lists a reviewer runtime as left out by design. It now names the reviewer-evidence contract that the drive reads and a reference reviewer that implements it, planned as `jig-harness/ai-review` in its own repository. The Standard level says the automated reviewer can be any reviewer that meets the contract. Decision record: [ADR-0027](../docs/adr/ADR-0027-jig-ships-a-reference-reviewer.md).
- M7's [mappings](../modules/M7-pr-lifecycle-review/mappings.md) gain a table of the reviewers a team can add with its own model key: PR-Agent, openai/codex-action, anthropics/claude-code-action, the opencode GitHub Action, CodeRabbit for public repositories and the reference reviewer. Each row says what the reviewer posts of the evidence the drive reads and whether drive-pr has a built-in profile for it.
- The [glossary](../GLOSSARY.md) defines *reviewer-evidence contract* and *reference reviewer*.
