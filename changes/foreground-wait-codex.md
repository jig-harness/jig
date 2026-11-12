---
release: patch
---

### Fixed

- A Codex drive pass no longer loses a long step between starting it and
  waiting on it. Codex ends every process a tool call started when the call
  returns, so drive-pr's foreground wait (`foreground-wait.ts`) now refuses
  to launch under Codex, exit `4`, before starting anything, and names the
  way to run the step there: `exec_command`, then `write_stdin` on the same
  session until the command exits
  ([drive-pr § Driver pass](../plugin/skills/drive-pr/SKILL.md#driver-pass-you-are-headless-and-one-shot)).
- A foreground wait whose runner was lost (exit `21`) now says so and shows
  at least the command's last 4 KiB of output, repeating what an earlier
  wait already showed, or says that the runner wrote no log at all.
