---
type: architecture
status: accepted
---

# Architecture: Saved views

## Review

```text
Reviewer: fresh-context red-team agent, 2026-05-06.
Challenged the storage choice; resolved before acceptance.
```

The review record lives inside a fenced block but carries real content, so it
must PASS — the fix must not reject fenced content, only an empty fence.
