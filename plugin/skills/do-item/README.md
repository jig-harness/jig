# Do item

Picking up an issue should keep its context, validation and review together.
Without a shared procedure, a started item can lose its findings between
sessions or reach a pull request without the checks its changes need.
`/jig:do-item <issue-key>` takes an issue from the configured tracker,
checks its context and human checkpoints, delegates the work, validates it,
opens a draft pull request under the repository's policy and arms
[`drive-pr`](../drive-pr/README.md). A person merges.

## Requirements and platforms

Install the [plugin requirements](../../README.md#requirements), and set
`issue_tracker.team` in the repository's `.config/jig.yaml`. The complete
procedure and configuration fields are in [SKILL.md](SKILL.md).

The instructions run in Bash on macOS and Linux, and PowerShell on Windows.
Make Bun, Git and GitHub CLI available to the command tool. Codex substitutes
the installed skill's absolute path for `${CLAUDE_SKILL_DIR}` before running a command. Generated
JSON and comment bodies are read from files, so no Git Bash utilities are needed.

Run every TypeScript script through `bun`, from the consumer repository's
root. For example, using the installed do-item skill directory:

```bash
bun "<skill-dir>/scripts/get_issue.ts" <issue-key>
```

Native Windows tests cover the pickup scripts and the drive's process
helpers. The complete interactive Windows smoke test — pick an item,
open its draft pull request, arm a drive, finish a pass and stop the drive —
is still pending. Automated component coverage does not establish that
interactive flow.

## Continuing work

Invoke the same skill with the issue key again. It refreshes tracker state,
checks whether prior findings can be reused and writes this session's intent
snapshot. An issue with children selects one eligible child at a time; human
checkpoints remain in force. Once a pull request exists, the drive owns its
review rounds. See [the drive's README](../drive-pr/README.md) for inspecting
or stopping it.
