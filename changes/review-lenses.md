---
release: minor
---

`review` runs review lenses: single checks, one Markdown file each, selected by what the diff adds or removes and run with fresh context in its semantic tier. The first seed lens, `jig.swallowed-failure`, checks a change against M15's rules on failures.

### Added

- **Review lenses in `/jig:review`'s semantic tier.** A [review lens](../GLOSSARY.md) is one check held in one file: its id and version, the module rules it enforces, the trigger that selects it, the evidence every finding must give, and what is and is not a finding ([the lens step](../plugin/skills/review/references/lenses.md)). `select-lenses.ts` runs each lens whose paths and line patterns the diff matches and says why it skipped the others; each selected lens runs as its own reviewer with fresh context (a subagent, else the harness's agent command inside the base snapshot, else the same session, said so in the summary). Every lens is comment-only for now: a finding's effective severity is at most `WARNING`, and `INFO` when its evidence field is empty. Tier 3's line gains `⚠️ WARNINGS` and `⏭️ N/A`, the summary a `Lenses:` line, and `APPROVED WITH WARNINGS` admits lens warnings. `--lens=<id>` runs a lens whatever its trigger says; `--quick`, `--tier=1`, `--tier=2` and `--skip-t3` run none.
- **`jig.swallowed-failure`**, the first [seed lens](../GLOSSARY.md): a failure turned into a value or silence, a fallback that hides the fault, a wrapper that drops the cause, work nobody waits for, a removed check, and a branch on an error's message text ([M15](../modules/M15-contracts-errors/README.md) pieces 1 and 3). Its eval fixtures, a diff it must flag and one it must stay quiet on, passed live.
- **`review.lenses`** in `.config/jig.yaml` ([CONFIGURATION.md](../plugin/CONFIGURATION.md)): `dir` for the repository's own lens files, `off` for lenses not to run, `triggers` for patterns appended to a lens's trigger. Read from the base branch; an id that names no lens, a pattern that is not a regular expression or a repository lens with the `jig.` prefix stops the review and is named.
- **The lens step in `/jig:do-item`'s pre-PR gate**, from a base snapshot of its own, skipped with the other tiers under the small-change threshold; lens warnings go under Review Notes.
- **`review.ts setup --base <branch>`** names the base branch directly, and **`--remote <name>`** the git remote it fetches and compares with (default `origin`).
- **`/jig:audit` checks `review.lenses`** the way review reads it: an `off` or `triggers` entry that names no seed or repository lens is reported as a refusal.

### Changed

- **`review`'s setup writes the effective diff** beside the effective file list, with every Git setting that could change what either shows fixed on the command line and attributes read from the merge base, so neither the caller's Git configuration nor a clean filter a change assigns in its own attributes file can hide an edit. **Breaking:** setup needs Git 2.41 or later and stops, naming the requirement, on an older Git; and a path named with `--files` that does not exist in the reviewed tree stops setup.
- [M7](../modules/M7-pr-lifecycle-review/README.md) leaves out only a lens catalogue beyond the seed lenses, and its `review-config.yaml` may reference a lens file (`file:`) or a seed lens's `id` instead of restating it.
