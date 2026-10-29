---
release: patch
---

### Changed

- The [`resolve-conflicts`](../plugin/skills/resolve-conflicts/SKILL.md) test that proves the history replay runs no configured filter no longer deletes its marker file before the replay, since no filter is configured until after the merge is recorded, and it says why the merge comes first. The skill itself is unchanged.
