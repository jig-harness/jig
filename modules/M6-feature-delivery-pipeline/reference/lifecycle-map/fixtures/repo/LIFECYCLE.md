# Lifecycle

How work moves, one stage at a time.

| Stage | Owner | Hands on | Detail |
|-------|-------|----------|--------|
| steer | [the plan](docs/plan.md) | a ranked list of work | |
| file | `/jig:file-issue` | an issue | |
| pick up | `/jig:do-item` | a branch | |
| pre-PR gates | `bun run gates`, then `bun scripts/check.ts` | a green run | |
| draft and drive | `/jig:drive-pr` and `/ship` | a pull request | |
| merge | a person, with `gh pr merge` | the merged commit | |
| post-merge | `/followup 12` | a settled tracker | [the process](docs/process.md) |

A code block is not a table:

```
| Stage | Owner | Hands on |
|-------|-------|----------|
| fenced | `/jig:nobody` | nothing |
```

Skills outside the loop:

| Skill | Used when |
|-------|-----------|
| `/jig:orphan` | the loop does not apply |
