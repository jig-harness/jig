---
release: patch
---

### Added

- Herdr is the workspace runtime Jig's tooling targets first
  ([ADR-0005](../docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)):
  the launcher's Herdr provider and checks of the skills inside Herdr are
  [ROADMAP.md](../ROADMAP.md) item 19, and
  [M12](../modules/M12-parallel-agent-ergonomics/mappings.md)'s mappings say
  where the worktree lifecycle hooks wire in Herdr: the create hook in the
  created worktree, the remove hook in a wrapper that parks before removing.
- `reflect` records `herdr` as the session's wrapper when the session runs
  in a Herdr pane.

### Changed

- The glossary defines *workspace runtime*, and its launcher and workspace
  provider entries no longer present one runtime as the one Jig uses.
- The documents the site shows say what Jig supports and plans rather than
  what its maintainers happen to use: tracker, design-tool, CI and agent-tool
  bindings are named as the current implementation, configuration examples
  use neutral values, and notes on how Jig itself is built and released
  moved to [CONTRIBUTING.md](../CONTRIBUTING.md).
- The roadmap is split: [ROADMAP.md](../ROADMAP.md), which the site shows,
  says in a few sentences what each item gives a team, and
  [design/plan.md](../design/plan.md) holds the detail and the work only
  Jig's maintainers need, under the same numbers; `bun run gates` checks
  that every roadmap item is in the plan in the same group and order, and
  that the documents the site shows cite only roadmap items.
- `resolve-review-comments` says which severity formats it reads from any
  reviewer and which only from CodeRabbit.
- The plugin README is written for teams that use the plugin: adding a
  skill to Jig and releasing it are in [CONTRIBUTING.md](../CONTRIBUTING.md).
- `review`'s interface-surface check asks for M15's upper bound on every
  published request input: a type, plus a maximum length, pattern or format
  on a string, a maximum on a number, a maximum item count on an array and a
  closed shape on an object.
