## Survey 3 — Automation and mechanical enforcement

Map every mechanical enforcement surface.

1. CI workflows: inventory with one-line purposes; identify the pipeline architecture (PR gates / post-merge verification / deploy / promotion / scheduled).
   Where read-only host access exists, verify the default branch, protection
   or rulesets, required checks and reviews, conversation resolution, and
   bypass actors. Keep checked-in workflow presence separate from required
   merge enforcement.
2. Git hooks (lefthook/husky/pre-commit/none): every hook, its trigger, whether it auto-fixes or blocks, and its escape hatch.
3. Quality gates: the canonical gate set (format/lint/types/tests/build) and where it is stated vs enforced.
4. Grep/pattern gates and custom check scripts; do they have self-tests? Do they run in both hooks and CI?
5. Generated artifacts: enumerate every committed generated file and whether it has (a) a regenerate script, (b) a drift check in CI, (c) a pre-commit auto-regen twin.
6. Change classification: is there any path→implication mapping (which changes trigger which gates/reviews/deploys), and is it a single source of truth or re-hardcoded per consumer?
7. Schema/API contract sync: migrations-to-types generation, OpenAPI/client-SDK drift checks.
8. Parallel-agent ergonomics (only where the repo is worked by multiple agents on one machine — worktree-based tooling): deterministic per-worktree port allocation, a cross-worktree heavy-run mutex, branch reuse-before-create discipline, documented footgun bans. If the repo shows no sign of parallel-agent use, mark "expected-absent" in one line and move on.

Synthesize: (A) an enforcement ladder per quality concern (editor → hook → CI → review → convention-only); (B) convention-only concerns that plausibly deserve a mechanical gate; (C) advisory gates that could be promoted to blocking; (D) the CI pipeline architecture (PR gates / verify / deploy / promotion) and whether a verified-artifact pointer separates "merged" from "verified".
