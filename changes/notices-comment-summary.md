---
release: patch
---

### Fixed

- A repository with more standing notices than its notices workspace's comment holds no longer fails them one by one. The dispatcher keeps room in every comment it writes for a summary entry that says how many notices wait, of which kinds and which ones, and that `jig ask --waiting` from the repository's checkout lists those that need a person. Where the comment leaves no room for the summary, the waiting notices are not counted in it until room opens. A notice that waits for room is not counted as a failed delivery, so it neither backs off nor raises an "action failing" notice of its own, and a failure the old rule recorded for it is cleared. Each goes in full once a person reads the workspace or its other entries settle.
