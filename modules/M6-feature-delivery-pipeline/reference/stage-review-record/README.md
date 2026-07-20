# Stage-review-record gate

The pipeline invariant says every stage artifact is **adversarially reviewed
before the next stage consumes it**. "Consumable" is marked in frontmatter as
`status: accepted`. This gate makes that review non-skippable: an artifact that
claims `status: accepted` must also carry a review record.

## Why it exists

`status: accepted` is a promise that a fresh-context, red-team review already
happened — the next stage builds on it without re-checking. Nothing stops an
author (or an agent) flipping a draft straight to `accepted` and skipping the
review. This gate ties the two together: acceptance without a recorded review
fails, so the status word cannot outrun the work it stands for.

## What counts as a review record

Either of these, so a team can keep the trail wherever it prefers:

| Where | What satisfies it |
|-------|-------------------|
| frontmatter | a `reviewed:` key whose value carries a reviewer plus an anchor — a date (`YYYY-MM-DD`), an issue/PR ref (`#123`), a URL, or a commit sha. A bare `reviewed: true` does not count |
| body | a non-empty `## Review` section — a heading whose text starts with "Review", with at least one content line under it |

The record is deliberately terse — a reviewer and an anchor, not the review
dialogue. [De-scarring](../../../../GLOSSARY.md) (see
[M4](../../../M4-docs-governance/)) keeps the finished artifact clean; the
findings history lives in the review threads and issues.

## Mechanism

One artifact per run, via arg 1 or `ARTIFACT=`.

| Artifact | Verdict |
|----------|---------|
| status not `accepted` (draft / proposed / absent) | pass — nothing to prove |
| `accepted` with a review record | pass |
| `accepted` with no record | fail (exit 1) |
| frontmatter opened with `---` but never closed | error (exit 2) |

```sh
./check-stage-accepted.sh prd.md
```

## Where it runs

Wire it as a **merge gate** on changed stage docs: a PR that flips an artifact
to `accepted` cannot merge until the record is present.
[CI](../../../../GLOSSARY.md) is the authority (see
[M1](../../../M1-gates-enforcement-ladder/)); per-forge wiring is in
[`mappings.md`](../../mappings.md).

## Files

| File | Role |
|------|------|
| `check-stage-accepted.sh` | the gate; artifact via arg/`ARTIFACT` |
| `test-check-stage-accepted.sh` | paired self-test (every pass/fail/error path) |
| `fixtures/draft.md` | draft — must pass |
| `fixtures/no-frontmatter.md` | no status — must pass |
| `fixtures/accepted-reviewed.md` | accepted + `reviewed:` key — must pass |
| `fixtures/accepted-review-section.md` | accepted + `## Review` section — must pass |
| `fixtures/accepted-no-review.md` | accepted, no record — must fail |
| `fixtures/accepted-empty-review.md` | accepted, empty `## Review` — must fail |
| `fixtures/accepted-reviewed-bare.md` | accepted, `reviewed: true` only — must fail |
| `fixtures/malformed.md` | unterminated frontmatter — must error (exit 2) |

Run the self-test with `./test-check-stage-accepted.sh`.
