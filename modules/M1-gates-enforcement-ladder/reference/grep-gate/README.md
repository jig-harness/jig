# Grep-gate framework

A grep gate (see [GLOSSARY.md](../../../../GLOSSARY.md)) is a deliberately
simple check: one small shell script that searches the codebase for a
forbidden or required pattern and fails with a readable report. Simple beats
clever here — a grep with a self-test outlives an unowned AST analyzer,
because anyone on the team can read, fix, and extend it.

This directory is the framework skeleton with one fully worked example:
**every `TODO` comment must reference an issue** (`TODO(#123)` or
`TODO(PROJ-123)`). The rule itself is a neutral placeholder — copy the pair
of scripts and swap in your own rule.

## The convention

1. **One script per rule** — `check-<rule>.sh`. It exits `0` on pass and `1`
   with a formatted violation report on failure. Directory paths come from
   env vars (here `SRC_DIR`) so the script is self-testable, and a missing
   or empty directory passes, so the gate can be wired up before the tree it
   guards exists.
2. **A paired self-test** — `test-<rule>.sh` runs the gate against small
   fixtures and asserts pass on clean input, fail on violations, and correct
   suppression behavior. The self-test is what keeps the gate honest: a gate
   whose regex silently stops matching is worse than no gate, because it
   still reports green.
3. **Fixtures** — minimal files under `fixtures/` exercising each behavior:
   `clean/` (must pass), `bad/` (must fail), and one per suppression or edge
   case. Keep them tiny and language-neutral where possible.
4. **Wired into both rungs** — the gate runs in the pre-push hook (fast local
   feedback; see `../../templates/lefthook.yml`) *and* in CI (the authority;
   see `../../templates/ci-pr-gates.yml`). CI also runs the self-test, so a
   broken gate fails loudly instead of passing silently.
5. **Suppressions are registered** — if the gate accepts an inline
   suppression token (this example accepts `todo-exempt: <reason>`, reason
   mandatory), the token gets a row in the suppression-token registry
   (`../../templates/suppression-registry.md`) in the same change that
   introduces it.

## Files

| File | Role |
|------|------|
| `check-todo-has-issue.sh` | the gate: scans `SRC_DIR` (default `src`) for bare TODOs |
| `test-todo-has-issue.sh` | the paired self-test |
| `fixtures/clean/` | issue-referenced TODOs — gate must pass |
| `fixtures/bad/` | bare TODO, TODO without colon, reason-less suppression — gate must fail |
| `fixtures/exempt/` | justified `todo-exempt:` suppression — gate must pass |

Run the self-test any time with `./test-todo-has-issue.sh`; it prints a
pass/fail line per case and exits non-zero on any failure.

## Adapting to your rule

Copy both scripts, rename `<rule>`, replace the stage-1 pattern (what to
find), the stage-2 pattern (what forms are allowed), and the suppression
token, then rewrite the fixtures to match. Keep the error message
actionable: say what the rule is, how to comply, and how to legitimately
suppress. Everything is plain bash + grep + coreutils — no language runtime
required, so the pair runs identically in hooks and in any CI image.
