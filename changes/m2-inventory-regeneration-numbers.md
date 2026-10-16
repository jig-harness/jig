---
release: minor
---

### Added

- M2's [generated-file inventory](../GLOSSARY.md): every derived file is
  declared once, with its outputs, its source, its regenerate command and
  its check, and one generic runner
  (`modules/M2-generated-artifact-freshness/reference/inventory/`) runs
  every declared check as the only CI step the practice needs, reporting
  every result and failing closed on an inventory it cannot read or a check
  that cannot start; each check runs in a process of its own with a
  deadline (`$JIG_COMMAND_TIMEOUT_SEC`, `lib/bounded-shell.ts`); a copyable
  inventory starter in M2's `templates/`.
- M3's catalog `generated:` block is the list of M2 inventory entries an
  area owns, which the runner reads straight from the catalog; Jig's own
  derived files are declared there and `bun run gates` runs their checks
  through the runner (`scripts/check-generated-files.ts`).
- Regeneration after merge through a pull request: the GitHub Actions
  skeleton `modules/M2-generated-artifact-freshness/templates/regenerate-after-merge.yml`
  (one pull request per generator on a fixed branch, merged by a person, no
  CI-skip marker on any commit, a credential of its own), with the
  steps for other providers in M2's `mappings.md`.
- Generator coverage (`reference/generator-coverage/`): the inputs a
  generator reads are the inputs that exist; and one-way derivation with
  structured artifacts compared as parsed data (`reference/compare-as-data/`).
- Numbers in prose: the constraint-versus-tally test in M2's README and in
  M0's `AGENTS-skeleton.md`; a facts registry checked exactly by
  `reference/prose-facts/check-registered-facts.ts` (each fact derived from
  globs or a command, every registered phrasing of a stated copy compared);
  and the advisory lint `reference/prose-facts/lint-derivable-counts.ts` over
  tallies nobody registered, with the `<!-- measured -->` escape.
- Audit criteria, each `since: next`: M2 `regeneration-after-merge-via-pull-request`,
  `generator-reaches-every-input`, `derivation-one-way-compared-as-data` and
  `numbers-in-prose-rule-stated`.

### Changed

- M2's Strict criterion `artifact-inventory-generated-and-gated` now asks
  for the declared inventory and the one runner, so it can be met;
  `prose-facts-ci-checked` asks for the registry and its phrasings.
- M3's graph-validated criterion and reference follow the inventory's field
  names (`generated[].source`), and the catalog checker validates `generated:`
  entries with the runner's own validation.
- CONTRIBUTING's derived-files section points at the catalog as the one
  source instead of carrying its own table.
- The shared `lib/files.ts` lists only files present on disk (a tracked file
  deleted from the working tree no longer counts), with forward slashes on
  every platform, and blanks code with CommonMark's fence grammar, now shared
  with `check-referenced-paths.ts`.
