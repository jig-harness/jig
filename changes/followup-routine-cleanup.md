---
release: patch
---

### Fixed

- Followup passes leave routine local branches, retired workspaces and scratch
  notes to periodic cleanup, even when no collector covers them yet. Their
  retention no longer calls for a human decision or a failed followup result.
  The lifecycle guidance and audit criterion keep active operational
  scaffolding and evidence of unlanded work in scope.
