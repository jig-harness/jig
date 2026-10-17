---
release: minor
---

The `changelog` skill: a repository turns change notes on with one section of its own configuration, and the release step and branch check read it.

### Added

- `/jig:changelog` ([README](../plugin/skills/changelog/README.md)): when a change needs a change note, how to write one a reader of the changelog can use, and `check.ts`, `status.ts` and `release.ts`, each printing the plugin version it ran as. It is on only in a repository whose own `.config/jig.yaml` sets `changelog.file`; elsewhere every command says `not configured` and writes nothing.
- The `changelog:` configuration section (`file`, `format`, `notes_dir`, `version`, `release_paths`, `note_paths`, `placeholders`, `after_version`, `unreleased`, `authors`, `tag_prefix`, `release.push`, `release.branch`), documented in [CONFIGURATION.md](../plugin/CONFIGURATION.md#changelog) and listed in the audit's configuration schema. It is read from the repository's own file alone: a user file or a `JIG__CHANGELOG__*` variable that sets a field is refused, never merged. The audit refuses what the skill refuses: it resolves the section against the repository, so a changelog, format, version file or version key that is missing, or version files that disagree, are reported.
- The branch check holds a branch to the `changelog:` section its base holds (`git show <base>:.config/jig.yaml`), so a pull request cannot weaken its own check. A branch that edits the section is also checked against the section it proposes, and the check prints the change.
- Common Changelog beside Keep a Changelog: format detection, its change types, no Unreleased section, references to the pull request or commit and the authors taken from git alone, one notice per release, `**Breaking:**` entries listed first and tied to `release: major`, a link definition per version.
- Versions kept in JSON, TOML or YAML files at a key, in a plain `VERSION` file, or only in tags; derived from `package.json`, `pyproject.toml` and `Cargo.toml` when the repository names none. Only the value at the key changes, and the file is parsed again to confirm it.
- `after_version`, a command the release step runs after it moves the version, for files that repeat it. Inside a CI job (`CI`, `GITHUB_ACTIONS` or another service's marker set) it runs only when the job sets `JIG_AFTER_VERSION_IN_CI=1`. Its output goes to standard error, and after `JIG_AFTER_VERSION_TIMEOUT_SEC` seconds (1800 by default) it is stopped with every process it started.
- `changelog.unreleased: wait` for Keep a Changelog, and a first-release link that points at the version's own tag.
- A structural check of each note with `Bun.markdown` for the format's change types; a Bun without it fails with the version it needs (1.4.3).

### Changed

- **Breaking:** `check.ts` and `release.ts` under `plugin/skills/changelog/scripts/` no longer take `--notes`, `--changelog`, `--version-file`, `--release-path` or `--stamp*`; they read the `changelog:` section of `.config/jig.yaml`. A repository that called them by hand moves those values into that section.
- Jig's own release step and changelog gate read the `changelog:` section of Jig's `.config/jig.yaml` instead of constants in `scripts/`.
