# Agent instructions: the `jig` plugin

These add to the [repository's AGENTS.md](../AGENTS.md) for anything under
`plugin/`. Claude Code and Codex install this directory from `main` onto every
machine that uses Jig, so a mistake here reaches every repository at
once.

## Rules

- **It runs from a copy.** Everything here must work from the plugin cache, a
  copy outside this repository with no `node_modules`: skill-relative paths
  (`${CLAUDE_SKILL_DIR}/…` in `SKILL.md`, `<skill-dir>/…` in reference files),
  the consumer repository as the working directory, Bun's built-ins (its own
  APIs and the `node:` modules it provides) or a vendored single-file build
  only. The details are in
  [README.md § Add or change a skill](README.md#add-or-change-a-skill);
  `tools/plugin/plugin.test.ts` checks the skills from a copy.
- **Consumer values are configuration.** A repository's values (bots, teams,
  labels, branch names, commands) are read at run time from its
  `.config/jig.yaml` and the other configuration layers, always through the
  shared reader in `skills/resolve-review-comments/scripts/lib/consumer.ts`,
  never by parsing the file directly. Every field is documented in
  [CONFIGURATION.md](CONFIGURATION.md) in the same pull request that adds or
  changes it, with its default and the skills that read it.
- **Every change ships as a version.** A pull request that changes `plugin/`
  adds a [change note](../changes/README.md) with `release: patch|minor|major`
  (say what a consumer must change first when it is breaking) and leaves both
  manifests' `version` and [CHANGELOG.md](../CHANGELOG.md) alone: after the
  merge, the release step moves the version, writes the section and tags
  `v<version>` ([README.md § Release a new version](README.md#release-a-new-version)).
  A `since:` it adds names `next`.
- **A new skill** gets a row in the skills table in [README.md](README.md),
  its name in both manifests' descriptions, its configuration in
  [CONFIGURATION.md](CONFIGURATION.md), and its tests in
  `skills/<name>/__tests__/`. A suite that needs POSIX or runs long is listed in
  [scripts/gates.ts](../scripts/gates.ts) with the reason.
- **Skills call each other by sibling path** (`../<skill>/scripts/…`), never
  through a path in the consumer repository.
- **`SKILL.md` is the agent's contract; `README.md` (where a skill has one) is
  the human's page.** Change both when behaviour changes; keep each to its
  reader.
- **No third-party lineage in procedures.** Jig may be published. Do
  not bring in a skill, or its procedure text, that came from a public skill
  collection; recommend it in [RECOMMENDED-SKILLS.md](RECOMMENDED-SKILLS.md)
  with credit instead. A permissively licensed library a skill depends on is a
  different case: vendor it with its licence notice beside it, list that
  licence file in the repository's `NOTICE` (copied here as
  [NOTICE](NOTICE)), and name it in the skill's documentation, as `decide`'s
  `ste-lint` port does.

## Verifying a change

```sh
JIG_GATES_SKIP_SEPARATE_SUITES=1 bun run gates
bun test --timeout 60000 plugin/skills/<skill>/__tests__/<file>.test.ts
```

The drive-pr suite takes a few minutes even with its files in parallel; run
the test files for what you changed and let CI's shards run the whole suite.
Inside a running drive, clear the inherited `DRIVE_PR_*` variables first
(`env $(env | grep -o '^DRIVE_PR_[A-Z_]*' | sed 's/^/-u /') bun test …`), or
the drive-status tests read the drive's own state.
