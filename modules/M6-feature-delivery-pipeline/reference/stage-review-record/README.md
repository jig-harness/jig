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
| frontmatter | a `reviewed:` key whose value carries a reviewer plus an anchor — a date (`YYYY-MM-DD`), an issue/PR ref (`#123`), a URL, or a commit sha. A bare `reviewed: true` does not count, nor does an anchor with no reviewer, nor text after a `#` comment marker |
| body | a non-empty `## Review` section — a heading whose text starts with "Review", with at least one content line under it. Content inside a fenced block counts; an empty fence or an HTML comment does not |

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
| frontmatter opened with `---` but never closed, or a duplicated `status:` or `reviewed:` key | error (exit 2) |

```sh
bun ./check-stage-accepted.ts prd.md
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
| `check-stage-accepted.ts` | the gate; artifact via arg/`ARTIFACT` |
| `check-stage-accepted.test.ts` | paired self-test (every pass/fail/error path) |
| `fixtures/draft.md` | draft — must pass |
| `fixtures/no-frontmatter.md` | no status — must pass |
| `fixtures/accepted-reviewed.md` | accepted + `reviewed:` key — must pass |
| `fixtures/accepted-reviewer-substring.md` | accepted, a reviewer whose name contains a boolean-looking word — must pass |
| `fixtures/accepted-review-section.md` | accepted + `## Review` section — must pass |
| `fixtures/accepted-fenced-content-review.md` | accepted, `## Review` content inside a fenced block — must pass |
| `fixtures/accepted-no-review.md` | accepted, no record — must fail |
| `fixtures/accepted-empty-review.md` | accepted, empty `## Review` — must fail |
| `fixtures/accepted-empty-fence-review.md` | accepted, `## Review` holding only an empty fence — must fail |
| `fixtures/accepted-html-comment-review.md` | accepted, `## Review` holding only an HTML comment — must fail |
| `fixtures/accepted-reviewed-bare.md` | accepted, `reviewed: true` only — must fail |
| `fixtures/accepted-comment-faked-review.md` | accepted, `reviewed: true` with the reviewer in a YAML comment — must fail |
| `fixtures/accepted-anchor-only.md` | accepted, `reviewed:` with a date but no reviewer — must fail |
| `fixtures/accepted-ref-only.md` | accepted, `reviewed:` with an issue ref but no reviewer — must fail |
| `fixtures/accepted-duplicate-status.md` | two `status:` keys — must error (exit 2) |
| `fixtures/malformed.md` | unterminated frontmatter — must error (exit 2) |

Run the self-test with `bun test ./check-stage-accepted.test.ts` (and run the shared cases with
`bun test ../../../../lib/module-gates.test.ts` from this directory).

The native gate uses the shared implementation in Jig’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts). Keep the module and
`lib/` together in the pinned Jig checkout when adopting it.
