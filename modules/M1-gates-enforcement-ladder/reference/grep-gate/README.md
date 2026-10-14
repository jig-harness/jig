# Grep-gate framework

A [grep gate](../../../../GLOSSARY.md) searches the codebase for a forbidden or
required pattern and fails with a readable report. Without a tested check,
a rule can silently stop catching violations while still reporting success.

This worked example requires every `TODO` comment to reference an issue
(`TODO(#123)` or `TODO(PROJ-123)`), or carry a justified `todo-exempt: <reason>`
suppression on the same line. The rule is a neutral example to adapt.

## The convention

1. Write one `check-<rule>.ts` per rule, with three outcomes: exit 0 when it
   passed, 1 on findings, and 2 when it [could not check](../../../../GLOSSARY.md):
   a scan root that is missing or holds nothing to scan, an input it cannot
   read. It [fails closed](../../../../GLOSSARY.md): a run that examined
   nothing never passes. Scan roots are configurable so fixtures can exercise
   the same command as real repositories.
2. Count what was scanned, and state it on green runs together with what the
   rule does not check, so a reader of the log knows how far the green
   reaches.
3. Report each finding with its rule, its file and line, the problem and the
   fix. Under GitHub Actions (`GITHUB_ACTIONS=true`) also print it as an
   `::error` workflow command, which shows on the changed line; the GitLab
   equivalent is in [M1 mappings](../../mappings.md#actionable-findings-in-ci).
4. Register every suppression token, require a reason at each use, and treat
   a token that suppresses nothing as a finding, so stale suppressions leave
   with the code they excused.
5. Pair the gate with Bun tests that assert every outcome: clean, a finding of
   each kind, a justified suppression, a stale one, a missing root and a root
   with nothing to scan, the annotation output and the scope line. Jig's
   example tests are in
   [scripts/freshness.test.ts](../../../../scripts/freshness.test.ts).
   Mutation-test them: remove each guard in a scratch copy and check that a
   test turns red.
6. Keep small, language-neutral inputs under `fixtures/`; build an input that
   cannot be committed (an empty folder) in the test.
7. Run the gate and tests locally and in CI. Local hooks provide fast feedback;
   CI remains the authority even when someone bypasses a hook.

A text pattern suits this rule because its question is about text: does
`TODO` appear without an issue reference. A rule about whether code runs or a
value takes effect needs a parser or an exact pinned text instead (M1 core
piece 3).

## Files

| File | Role |
|------|------|
| `check-todo-has-issue.ts` | Scans the text files under `SRC_DIR` (default `src`) for bare TODOs; binary files are skipped. A missing `SRC_DIR`, or one with no text file, exits 2 |
| `fixtures/clean/` | Issue-referenced TODOs pass |
| `fixtures/bad/` | Bare TODOs and a reason-less suppression fail |
| `fixtures/no-reason/` | A reason-less suppression alone fails |
| `fixtures/exempt/` | Justified suppressions pass |
| `fixtures/stale/` | A suppression on a line with no TODO fails |
| `fixtures/stale-with-issue/` | A suppression beside a TODO that already cites an issue fails |
| `fixtures/mixed-exempt/` | A suppression beside a bare TODO passes, even when another TODO on the line cites an issue |
| `fixtures/mixed-bare/` | A bare TODO fails even when another TODO on the line cites an issue |
| `fixtures/double-exempt/` | A second suppression on one line fails |
| `fixtures/todo-in-key/` | A TODO inside a cited issue key is part of that citation, not a bare TODO |
| `fixtures/stale-todo-in-key/` | A suppression beside a TODO whose issue key contains `TODO` fails |

The finding and annotation format comes from
[`lib/findings.ts`](../../../../lib/findings.ts).

Run `bun test scripts/freshness.test.ts` from the Jig root. To adapt
the rule, change the candidate, allowed-form and suppression patterns, then
rewrite the fixtures. The native implementation needs the pinned Bun runtime
and its shared imports; see [M1 mappings](../../mappings.md).
