---
release: patch
---

### Fixed

- The [`resolve-conflicts`](../plugin/skills/resolve-conflicts/SKILL.md) test that proves the history replay runs no configured filter now records its merge before it configures the filter, so it runs under git 2.53, which refuses to stage a file under a process filter that exits at once. The replay itself is unchanged.
