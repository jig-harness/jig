# Grep-gate framework

A [grep gate](../../../../GLOSSARY.md) searches the codebase for a forbidden or
required pattern and fails with a readable report. Without a tested check,
a rule can silently stop catching violations while still reporting success.

This worked example requires every `TODO` comment to reference an issue
(`TODO(#123)` or `TODO(PROJ-123)`), or carry a justified `todo-exempt: <reason>`
suppression on the same line. The rule is a neutral example to adapt.

## The convention

1. Write one `check-<rule>.ts` per rule. Exit 0 on pass, 1 on violations,
   and 2 on unreadable or invalid inputs. Scan roots are configurable so
   fixtures can exercise the same command as real repositories.
2. Pair it with Bun tests that assert clean, bad and suppression verdicts.
   Groundwork's example tests are in
   [scripts/freshness.test.ts](../../../../scripts/freshness.test.ts).
3. Keep small, language-neutral inputs under `fixtures/`.
4. Run the gate and tests locally and in CI. Local hooks provide fast feedback;
   CI remains the authority even when someone bypasses a hook.
5. Register every suppression token and require a reason at each use.

## Files

| File | Role |
|------|------|
| `check-todo-has-issue.ts` | Scans `SRC_DIR` (default `src`) for bare TODOs; binary files are skipped, and a missing `SRC_DIR` passes because there is nothing to check |
| `fixtures/clean/` | Issue-referenced TODOs pass |
| `fixtures/bad/` | Bare TODOs and reason-less suppressions fail |
| `fixtures/exempt/` | Justified suppressions pass |

Run `bun test scripts/freshness.test.ts` from the Groundwork root. To adapt
the rule, change the candidate, allowed-form and suppression patterns, then
rewrite the fixtures. The native implementation needs the pinned Bun runtime
and its shared imports; see [M1 mappings](../../mappings.md).
