## Survey 3 — Automation and mechanical enforcement

Your modules (the answers you return): M1, M2, M3, M10, M12, M13, M14, M15 and M16.

Map every mechanical enforcement surface.

1. CI workflows: inventory with one-line purposes; identify the pipeline architecture (PR gates / post-merge verification / deploy / promotion / scheduled).
   Take the default branch, protection or rulesets, required checks and
   reviews, conversation resolution and bypass actors from `fit.json`; query
   the host only for what it does not hold, and mark unchecked what neither
   settles. Keep checked-in workflow presence separate from required merge
   enforcement.
2. Git hooks (lefthook/husky/pre-commit/none): every hook, its trigger, whether it auto-fixes or blocks, its escape hatch, and what installs the hook manager in a fresh checkout (a check that runs only in a hook is advisory: anyone can skip it).
3. Quality gates: the canonical gate set (format/lint/types/tests/build) and where it is stated vs enforced.
4. Grep/pattern gates and custom check scripts; do they have self-tests? Do they run in both hooks and CI?
5. Generated artifacts: enumerate every committed generated file and whether it has (a) a regenerate script, (b) a drift check in CI, (c) a pre-commit auto-regen twin. Where a generator has a documented read-only check mode (a type generator's `--check`, `tsc --noEmit`, a frozen-lockfile install check, or `bun "<skill-dir>/../../shared/command.ts" -- git diff --exit-code` after running the generator in a scratch copy of the checkout), run it and report its exit status and output as freshness evidence; never write into the checkout.
6. Change classification: is there any path→implication mapping (which changes trigger which gates/reviews/deploys), and is it a single source of truth or re-hardcoded per consumer?
7. Schema/API contract sync: migrations-to-types generation, OpenAPI/client-SDK drift checks.
8. Testing strategy: each test suite's tier, trigger and time budget, and where the full end-to-end sweep runs (and whether anything stops it gaining a per-change trigger); whether test files are type-checked; any check that changed source files come with tests, and whether it fails an exemption that matches no file; lint rules or gates against wall-clock reads and fixed sleeps, and whether a sleep's suppression token fails once no delay sits beside it; whether isolation predicates (tenant scope, soft delete, authorization) are tested against the real engine; how tests are kept off the developer's home directory and configuration; and whether coverage is a scheduled trend or a per-file gate.
9. Parallel-agent ergonomics. Where the repo is worked by multiple agents on one machine (worktree-based tooling): deterministic per-worktree port allocation, a cross-worktree heavy-run mutex, branch reuse-before-create discipline, documented footgun bans. If the repo shows no sign of parallel-agent use, mark these worktree criteria "expected-absent" in one line; the assessments below still apply. Separately, wherever pull requests record a changelog entry or a version bump: does each add a note file of its own (`changes/`, `.changeset/`, `changelog.d/`, `newsfragments/`), and does a release step on the integration branch write the notes in after the merge, with a check that fails a direct edit to the changelog or the version? A repository with no changelog or version that changes per pull request is expected-absent here.
   Wherever people or agents work in parallel (including across machines),
   inspect the supplied `merge-conflicts.json` report: state its window,
   recurrence threshold, reachable-ref scope, skipped merges and cause
   accuracy. The history report does not read live events; state clone-local
   coverage for any retained live-event evidence supplied separately. For each hotspot, find the
   remedy, planned work or keep decision with a reason and revisit condition;
   compare retained reports over like windows after remedies. The audit's
   own replay shows current conflicts but does not establish that the target
   already measures or acts on them. No replayable merge or live event does
   not prove no conflicts; unsupported git or a failed replay stays unchecked.
   For a historical snapshot, use its retained evidence instead of the
   current refs and clone's events.
10. Releases and versions (only where the repository publishes a versioned artifact: a package, a tool, a plugin, a client library; otherwise mark "expected-absent" in one line): name each released artifact, its changelog and where its version lives; whether a written rule says which changes get an entry (those its consumers notice) and whether the changelog follows it (CI, website or internal tooling entries are evidence it does not); whether tags exist for the released versions; whether a release step on the integration branch sets the version, one run at a time, and a pull-request check requires a change to the shipped files to ask for a release; for several artifacts at their own versions, a changelog and a version per artifact; whether the tag is made only after the releasing commit's checks pass and publishing starts from the tag; and which identity pushes the release and how far the branch rules let it past (or whether a release pull request carries it).

Synthesize: (A) an enforcement ladder per quality concern (editor → hook → CI → review → convention-only); (B) convention-only concerns that plausibly deserve a mechanical gate; (C) advisory gates that could be promoted to blocking; (D) the CI pipeline architecture (PR gates / verify / deploy / promotion) and whether a verified-artifact pointer separates "merged" from "verified".
