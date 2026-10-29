---
release: minor
---

### Added

- The [`docs` skill](../plugin/skills/docs/README.md) (`/jig:docs`), the runnable form of [M4](../modules/M4-docs-governance/README.md): one pass over a repository's docs tree that runs the frontmatter check, the index freshness check, the `last_updated` check over the branch, the scar lint and the deferral check, prints the findings by file (or as JSON), warns of drafts not updated for longer than `docs.stale_after_days` (180 days by default), and lists the documents the project's type calls for and the tree lacks: an index, the wiki schema, an activity log and decision records for every project, runbooks for a service, a reference for a library. It detects the docs tree, the schema and the project type; the new `docs.root`, `docs.schema` and `docs.stale_after_days` fields correct it ([configuration](../plugin/CONFIGURATION.md#procedure-skills)).

### Changed

- **Breaking** for a repository that runs one of M4's reference gates from a Jig checkout: the gates moved from `modules/M4-docs-governance/reference/` into the skill, at `plugin/skills/docs/scripts/` (`frontmatter-check/`, `index/`, `stale-last-updated/`, `stamp/`, `scar-lint/`, `deferral-references/`, and the shared reader at `lib/docs.ts`). Each keeps its command line, variables and exit codes, so a hook or CI job changes only the path; the scar lint's self-test is now `plugin/skills/docs/__tests__/check-descarring-scars.test.ts`. The frontmatter check reads its schema with the plugin's vendored js-yaml, so a vendored copy keeps the plugin's layout (`skills/docs/` beside `shared/`) instead of Jig's `lib/`. M4's [mappings](../modules/M4-docs-governance/mappings.md) and the `deferral-liveness.yml` template name the new paths.
- The audit's configuration-fit check runs the `docs` skill's own validation of the `docs` section, so it reports what `/jig:docs` refuses: a root or schema outside the repository, including through a symbolic link, and a `stale_after_days` that is not a whole number of days.
- `descar` runs the `docs` skill's scar lint when the repository has none of its own, instead of reading every page by hand.
