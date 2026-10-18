---
release: patch
---

### Added

- The plugin guide opens with [Set up from an agent session](../plugin/README.md#set-up-from-an-agent-session):
  a prompt to paste into Claude Code or Codex in the repository you want
  to adopt Jig in. The agent checks whether the plugin is installed and runs
  the first audit if it is; otherwise it checks the requirements, gives you
  the install command to run, and stops.
- Website: a getting-started page at `/adopt/` hands the setup to your agent,
  or walks you from nothing installed to a first audit, then to the guide
  for your repository. The home page links to it, and the root `llms.txt`
  lists it first, under "Start here".

### Changed

- Website: everything about adopting Jig is one section under **Adopt**,
  with a switch between its pages. The existing-repository guide moved to
  `/adopt/existing/`, and the plugin's pages moved from `/plugin/` to
  `/adopt/plugin/`, `/adopt/configuration/` and `/adopt/extending/`. The
  "Install" navigation item is gone, and `/plugin/llms.txt` is merged into
  `/adopt/llms.txt`.
