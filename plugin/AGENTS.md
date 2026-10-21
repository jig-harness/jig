# Agent instructions: the `jig` plugin

These add to the [repository's AGENTS.md](../AGENTS.md) for anything under
`plugin/`. Claude Code and Codex install this directory onto every machine
that uses Jig, from the release channels built out of each version's tag
([README.md § Release channels](README.md#release-channels)), so a mistake
here reaches every repository at once.

## Rules

- **It runs from a copy.** Everything here must work from the plugin cache, a
  copy outside this repository with no `node_modules`: skill-relative paths
  (`${CLAUDE_SKILL_DIR}/…` in `SKILL.md`, `<skill-dir>/…` in reference files),
  the consumer repository as the working directory, Bun's built-ins (its own
  APIs and the `node:` modules it provides) or a vendored single-file build
  only. The details are in
  [CONTRIBUTING.md § Adding or changing a plugin skill](../CONTRIBUTING.md#adding-or-changing-a-plugin-skill);
  `tools/plugin/plugin.test.ts` checks the whole plugin from a copy built the
  way the channels ship it. That copy leaves out `__tests__/`, `AGENTS.md`
  and `CLAUDE.md` (`tools/plugin/artifact.ts`), so nothing that runs may read
  them.
- **The name never changes.** The plugin and both marketplaces are named
  `jig`, and `jig@jig` is what every machine and every repository's
  `enabledPlugins` know it by; `bun run gates` (`scripts/check-plugin.ts`)
  fails another name. Should a rename ever be unavoidable, the Claude Code
  marketplace's `renames` map carries the old name to the new one.
- **Consumer values are configuration.** A repository's values (bots, teams,
  labels, branch names, commands) are read at run time from its
  `.config/jig.yaml` and the other configuration layers, always through the
  shared reader in `shared/consumer.ts`,
  never by parsing the file directly. Every field is documented in
  [CONFIGURATION.md](CONFIGURATION.md) in the same pull request that adds or
  changes it, with its default and the skills that read it.
- **Every change ships as a version.** A pull request that changes `plugin/`
  adds a [change note](../changes/README.md) with `release: patch|minor|major`
  (say what a consumer must change first when it is breaking) and leaves both
  manifests' `version` and [CHANGELOG.md](../CHANGELOG.md) alone: after the
  merge, the release step moves the version and writes the section, and the
  release commit is tagged `v<version>` once its gates pass ([CONTRIBUTING.md § Releasing the plugin](../CONTRIBUTING.md#releasing-the-plugin)).
  A `since:` it adds names `next`.
- **A new skill** gets a row in the skills table in [README.md](README.md),
  a place in [Jig's lifecycle map](../docs/LIFECYCLE.md) (the gates fail a
  skill no stage names), its name in both manifests' descriptions, its configuration in
  [CONFIGURATION.md](CONFIGURATION.md), and its tests in
  `skills/<name>/__tests__/`. A suite that needs POSIX or runs long is listed in
  [scripts/gates.ts](../scripts/gates.ts) with the reason.
- **Code more than one skill uses lives in `shared/`**, beside `skills/`:
  skills import it by relative path, and nothing in `shared/` imports from a
  skill. A module moves
  there, with its tests in `shared/__tests__/`, when a second skill needs it.
  A skill's own logic that another skill reads stays in the skill.
- **A skill holds the templates and gates it uses.** The plugin installs only
  this directory, so a template or a gate a skill uses moves in from its module
  (`templates/`, `scripts/` with `__tests__/`), never copied, and the module
  links to it ([modules/AGENTS.md](../modules/AGENTS.md#the-module-contract)). A
  template in a skill is licensed MIT No Attribution and listed in the root
  NOTICE (copied here as [NOTICE](NOTICE): `cp NOTICE plugin/`).
- **Skills call each other by sibling path** (`../<skill>/scripts/…`), never
  through a path in the consumer repository.
- **A hook** lives in `hooks/<name>.ts`, is registered in `hooks/hooks.json`
  through `${CLAUDE_PLUGIN_ROOT}` (the one file both tools read), holds to
  the rules of M1's rung
  ([core piece 8](../modules/M1-gates-enforcement-ladder/README.md#core-pieces)),
  and has its tests in `hooks/__tests__/`; `tools/plugin/plugin.test.ts`
  runs it from a copy.
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

## Authoring a skill

A skill's description is read in every session, its `SKILL.md` when it
runs, and each reference when `SKILL.md` sends the agent there. Write each
part for that moment; the rules and their reasons are
[M0 § Skills](../modules/M0-instruction-architecture/README.md#skills).

- **The description leads with the trigger** that tells the skill apart from
  its neighbours, and carries its negative triggers ("not for X; use Y
  instead"): nothing else is read before the choice. Its length is held by
  `scripts/check-context-budget.ts`.
- **Every reference is named in `SKILL.md`**, with when to read it; a
  reference over 100 lines opens with a contents section linking to its
  headings.
- **No incident history and no time-sensitive phrasing** in `SKILL.md` or a
  reference: keep the rule, state the condition or the version.
- **Discovery controls for what they do**: `paths:` for a skill tied to a
  file area; `disable-model-invocation: true` only for a skill the user must
  start (check first that no workflow calls it); `user-invocable: false`
  hides a menu entry and saves no budget.

`bun run quality` counts what a script can see of these rules for every
skill file (M0's skill-authoring check, as a counter of the ratchet) and
fails a change that adds to any file's count for any rule. Bring a count
down when you edit the file; a renamed or split file carries its debt as new
findings, so fix the debt in that change. See every finding with
`bun modules/M0-instruction-architecture/reference/skill-authoring/check-skill-authoring.ts plugin/skills`.

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

## Changing `drive-pr`

Read [skills/drive-pr/references/consistency.md](skills/drive-pr/references/consistency.md)
first. The suite runs from this repository's root (`bun test
plugin/skills/drive-pr`; the root `bunfig.toml` supplies the preloads), never
from the plugin cache, and
the `skills/drive-pr/__tests__/terminal-states*.test.ts` suites
check that every terminal state's exit code agrees across `scripts/`,
`SKILL.md`, the README and `skills/drive-pr/references/terminal-states.md`. When a script's
behaviour changes, search `SKILL.md` and `references/` for sentences that
state the old behaviour, in the same edit.

- **Every outbound call has a deadline.** Spawn it through `skills/drive-pr/scripts/lib/proc.ts`
  (`ghCall`, or `run` with a `timeoutSec`): an unbounded call is a silent
  stall, not an error, and nothing upstream can end it.
- **A once-per-pass step is skipped only under a predicate that makes the
  skip safe.** "The next pass will run it" holds only when there is a next
  pass, and every terminal verdict, `CONVERGED` included, ends the drive. A
  skip gated only on the pass's own flags is therefore a permanent drop: an
  unreadable liveness probe that skips the replied-thread sweep, followed by
  a verdict that does not re-arm, lets one failed `gh` call leave threads
  unresolved. Where no narrower proof of safety exists, end the pass as
  `INDETERMINATE` (exit `1`) so the caller runs it again. `CONVERGED`'s
  `--no-count` re-read is a skip this permits: `sweepRanAndFailed` tells a
  sweep that was never attempted (certifies) from one that was attempted and
  failed (withholds `CONVERGED`).
