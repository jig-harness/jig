# jig.swallowed-failure@1: live run

- **Date:** 2026-10-28
- **Runner:** one fresh non-interactive agent run per fixture
  (`claude -p`, the strongest model, no project or user settings), each given the
  brief `review` writes for this lens (`lens-brief.ts`) with the fixture as
  the diff and no earlier findings.
- **Verdict:** passed.

| Fixture | Must | Result |
|---------|------|--------|
| `must-flag.diff` | flag the catch that turns every failure of the order load into `[]`, the branch on the text of the error message, and the wrapper that drops its cause | 3 findings, one for each, each with its `absorbed-failures` evidence naming the call and where its failure ends up |
| `must-stay-quiet.diff` | stay quiet on a fallback stated as intended that reports the failure with its cause, a wrapper that keeps its cause, and a branch on type and code | `[]` |
