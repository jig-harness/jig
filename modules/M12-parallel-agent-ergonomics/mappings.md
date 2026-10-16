# M12 mappings — per-ecosystem implementations

The module [invariant](README.md) — deterministic per-worktree ports, a
cross-worktree heavy-run mutex with a CI bypass, branch reuse-before-create,
change records of their own assembled after the merge, banned shared-state
footguns, and gate output shaped for an agent — is tool-independent. This file maps its mechanisms
onto concrete worktree managers / agent runners, package managers, and
[CI](../../GLOSSARY.md) providers. Replace `<placeholders>` with your values.

## The utilities, and where they plug in

The module ships portable scripts for the mechanisms below; the rest is
convention. Run the resource-lock script from a pinned Jig checkout, keeping
`plugin/shared/cleanup.ts` at its relative path for the process cleanup
registry. Point one variable at the module in that checkout and build
paths from it, exactly as the other modules do. The change-note commands
ship inside the plugin; run them from its installed cache with the consumer
repository as the working directory.

| Utility | Runs where | Signal it reads |
|---------|-----------|-----------------|
| `reference/port-allocator/allocate-port.ts` | worktree-create hook and/or the dev script | worktree id (arg or `WORKTREE_ID`), range via `PORT_BASE`/`PORT_SPAN` |
| `reference/resource-lock/with-resource-lock.ts` | around heavy local gate commands (build, test, e2e) | lock via `LOCK_NAME`/`--lock`; bypass via `CI`/`RESOURCE_LOCK_BYPASS` |
| [`changelog/scripts/release.ts`](../../plugin/skills/changelog/scripts/release.ts) | on the integration branch after every merge, one run at a time | notes directory, changelog and version files via flags |
| [`changelog/scripts/check.ts`](../../plugin/skills/changelog/scripts/check.ts) | in the branch gates | the same, plus `--base` and `--release-path` |
| `reference/quiet-run/quiet-run.ts` | around each gate command an agent runs (a `test:quiet` script, or a runtime hook) | `--name` per part, `--tail` for the lines a green run shows |
| `reference/worktree-namespace/namespace-for-worktree.ts` | the migration or dev command, and the create hook | the worktree's branch (arg or `WORKTREE_ID`), `--prefix`, `--max-length` |
| `reference/worktree-namespace/find-stale-namespaces.ts` | the owner's reap command, before any drop | the inventory via `--inventory`, `git worktree list --porcelain` via `--live`, `--owner`, `--production` (required) |

## Worktree managers / agent runners — where the hooks wire

The create hook allocates and prints the port slot; the remove hook nudges
reflection. Only the wiring point differs per tool.

| Manager | Create-hook point | Remove-hook point | Notes |
|---------|-------------------|-------------------|-------|
| plain `git worktree` | a wrapper script/alias around `git worktree add` | a wrapper around `git worktree remove` | git itself has no add/remove hook event; the wrapper is the seam |
| worktree-based agent runner (e.g. a per-workspace runner such as Conductor) | the runner's post-create / workspace-setup hook | the runner's pre-remove / teardown hook | the runner already brackets a session — the natural home for both |
| `direnv` / per-directory env | `.envrc` calls `allocate-port.ts` on entry and exports `PORT` | none (no teardown event) | derived ports mean no cleanup is needed |
| tmux / shell session per worktree | shell rc sources a per-worktree env file | a shell `EXIT` trap prints the reflection nudge | lightweight; good when there is no formal manager |

Because ports are **derived**, the create hook is convenience, not correctness:
any dev script can call `allocate-port.ts` directly and get the identical port
without a hook having fired.

## Package managers — the wrong-root-install footgun

The footgun ban "no root install with the wrong package manager" is concrete per
ecosystem: each manager owns a lockfile that a foreign install rewrites, breaking
every sibling worktree that shares it. Detect the declared manager (derive from
the lockfile present) and reject the others.

| Ecosystem | Declared by (lockfile) | The wrong-root-install that bites | Mechanizable check |
|-----------|------------------------|-----------------------------------|--------------------|
| Node | `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` / `bun.lockb` | running a different manager's `install` at the root rewrites/duplicates the lockfile | a hook asserting the lockfile matches the declared manager before install |
| Python | `poetry.lock` / `uv.lock` / `Pipfile.lock` | a bare `pip install` into the shared env instead of the project's | pre-commit / setup check that the project manager is used |
| Rust | `Cargo.lock` | hand-editing or a divergent `cargo update` at the root | review + lockfile-drift gate |
| Go | `go.sum` | `go get` bumping shared module state mid-session | `go mod verify` in a gate |

The general rule: **derive the package manager from the repo (don't declare it)**
and treat any other manager's root install as the banned action.

## CI providers — why (and how) the mutex bypasses

A CI runner already gives each job its own isolated machine, so the
cross-worktree mutex has nothing to serialize there and the wait would be pure
added latency. `with-resource-lock.ts` therefore runs the command unlocked when
it sees a CI signal. Most providers set `CI=true` automatically, so the bypass is
usually zero-config; the column below is the signal to rely on (or set
`RESOURCE_LOCK_BYPASS=1` explicitly).

| Provider | Auto-set signal | Note |
|----------|-----------------|------|
| GitHub Actions | `CI=true` | also `GITHUB_ACTIONS=true`; the default `CI` is enough |
| GitLab CI | `CI=true` | also `GITLAB_CI=true` |
| Buildkite | `CI=true` | one agent per job — already isolated |
| Jenkins | `CI` not guaranteed | set `RESOURCE_LOCK_BYPASS=1` (or `CI=1`) in the job env |

Locally, leave heavy commands wrapped:

```sh
bun with-resource-lock.ts --lock test -- pnpm test     # serialized across worktrees
```

In CI, run them unwrapped or wrapped — either way the bypass makes them run
immediately:

```yaml
# GitHub Actions — CI=true is already set, so even a wrapped command runs at once
- run: pnpm test
```

The mutex is the **same mechanism** [M1](../M1-gates-enforcement-ladder/) points
to for heavy pre-push gates; a repo that adopts both wraps its heavy gate once
and gets the cross-worktree serialization locally and the isolation-based bypass
in CI for free.

## Per-worktree data namespaces

The name comes from
[`reference/worktree-namespace/`](reference/worktree-namespace/); the create
writes the owner and the expiry beside it; the reaper reads them back into
the decision script's inventory and drops what it lists, after the report.
The drop decides each name again under a per-name lock the create also
holds, from a fresh census, because a worktree can come back on the same
branch between the report and the drop
([the reference's drop step](reference/worktree-namespace/README.md#from-decision-to-drop)).
The same shape on every database: only the commands differ.

| Database | Create, with owner and expiry | Inventory for the reaper | Drop |
|----------|-------------------------------|--------------------------|------|
| PostgreSQL | `CREATE SCHEMA "$NS"; COMMENT ON SCHEMA "$NS" IS '{"owner":"$USER","expires_at":"<ISO 8601>"}'`; the migration runner sets `search_path` to the namespace, and production (the `public` schema, no prefix) needs an explicit opt-in flag | `SELECT jsonb_agg(jsonb_build_object('name', n.nspname) \|\| coalesce(obj_description(n.oid, 'pg_namespace')::jsonb, '{}'::jsonb)) FROM pg_namespace n` | `DROP SCHEMA "$NS" CASCADE` |
| MySQL / MariaDB | `CREATE DATABASE $NS`; owner and expiry in a `worktree_namespaces` table, since a database carries no comment | `SELECT name, owner, expires_at FROM worktree_namespaces` joined with `SHOW DATABASES` | `DROP DATABASE $NS` |
| MongoDB | a database per worktree, owner and expiry as a document in a `namespaces` collection of an admin database | that collection, joined with `listDatabases` | `db.dropDatabase()` on the namespace |
| A branching database host (Neon, PlanetScale) | a branch per worktree, named by the script, with the host's expiry or a tag for owner and expiry | the host's branch list | the host's delete-branch call |
| SQLite | a file per worktree under a gitignored directory, owner and expiry in a sidecar `.json` | the directory listing | delete the file and its sidecar |
| Redis / Valkey | a key prefix per worktree rather than a database; owner and expiry in a hash under the prefix | `SCAN` by the prefix, reading the hash | `UNLINK` the keys under the prefix |

A production target is refused in the migration runner (the empty prefix
needs an explicit flag), in the reaper (`--production <name>` is never a
candidate), and wherever the drop runs, so no single mistake reaches it.

## Change notes — per ecosystem

The invariant: no pull request edits a file every pull request edits. Each
change adds a note of its own, and one run at a time on the integration branch
writes the notes into the changelog and moves the version. The tools below do
that; they differ in where the notes live, how the release is chosen, and
which changelog format they write.

| Tool | Ecosystem | Notes | Release step | Changelog it writes |
|------|-----------|-------|--------------|---------------------|
| [`changelog` scripts](../../plugin/skills/changelog/scripts/README.md) | any (Bun script) | `changes/*.md`, front matter `release: patch\|minor\|major`, Keep a Changelog sections | `release.ts` after each merge; the caller commits, tags and pushes | Keep a Changelog, with Unreleased for notes that ask for no release; versions in JSON files |
| [Changesets](https://github.com/changesets/changesets) | JavaScript / TypeScript packages | `.changeset/*.md`, front matter naming each package and its bump | `changeset version`; its GitHub Action keeps a "Version Packages" pull request open that a person merges | its own format, grouped by bump (Major / Minor / Patch Changes), per package; versions in `package.json` only |
| [towncrier](https://towncrier.readthedocs.io/) | Python, any | `newsfragments/<id>.<type>` files | `towncrier build --version <v>`; the version is given, not computed; `towncrier check` fails a branch without a fragment | configurable template and types |
| [scriv](https://scriv.readthedocs.io/) | Python, any | `changelog.d/*.md` or `.rst` | `scriv collect --version <v>` | Keep a Changelog's types by default |
| [changie](https://changie.dev/) | any (Go binary) | `.changes/unreleased/*.yaml`, one kind each | `changie batch <version\|auto>` then `changie merge`; `auto` derives the bump from the kinds | configurable; Keep a Changelog's kinds by default |

Choose by the version you release: Changesets fits a repository whose
released artifacts are npm packages; a repository whose version lives
elsewhere (a plugin manifest, a `pyproject.toml`, a Go tag) or that wants
Keep a Changelog's Unreleased for changes outside any release fits the
reference or changie better.

Two neighbouring approaches remove the conflicts without notes, at a cost:

- **Generate the changelog from commits** (release-please,
  semantic-release, GitLab's changelog API from `Changelog:` commit
  trailers). Nothing per pull request to conflict on, but each entry is a
  commit subject, written for a reviewer rather than a reader.
- **A union merge driver** (`CHANGELOG.md merge=union` in `.gitattributes`)
  lets git keep both sides of a local merge, but places lines without
  knowing the changelog's sections, does nothing for the version, and
  GitHub's mergeability check does not use it: the pull request still shows
  as conflicting.

Whatever the tool, the release step pushes to the integration branch. Where
that branch is protected, give the step an identity allowed past the
protection (a GitHub App or a token stored as a secret, with contents write
on that repository only), or have it open a release pull request a person
merges.

## Agent-facing gate output

The invariant: a gate speaks to an agent in a condensed voice on green and
in full on red, keeps its own exit status, and prints one verdict line per
part. Two seams carry it: the runner's own flags, and a wrapper the
repository or the agent runtime applies. The wrapper is
[`reference/quiet-run/`](reference/quiet-run/); the flags below condense
less than it does, but cost nothing to adopt.

### Runner flags

| Runner | Quieter on green | On red | Trap |
|--------|------------------|--------|------|
| `go test` (no `-v`) | one `ok` / `FAIL` line per package: the verdict-per-part shape, built in | a failing package prints its output in full | `-v` turns every test into a line again |
| pytest | `-q` (or `-qq`), `--tb=short` | failures keep their traceback | an argument that matches nothing must fail the run, not report that no tests ran: the wrapper's shell sets its no-match option (`failglob`) for that reason |
| vitest | `--reporter=dot` | failures print in full under every reporter | `--silent` drops the tests' own console output, which is often the diagnostic |
| Jest | `--reporters=summary` | the same | `--silent`, the same |
| `bun test` | no condensing flag: wrap it | — | — |
| `cargo test` | `-q` | failures print in full | — |
| Biome | `--reporter=summary` | the summary lists each failing rule | — |
| ESLint | — | — | `--quiet` hides warnings, not success noise: with a ratchet counting warnings ([M1](../M1-gates-enforcement-ladder/README.md)) it hides what the ratchet counts |
| `tsc` | prints nothing on success already | errors only | — |
| Turborepo | `--output-logs=errors-only`: a task's log only when it fails | the failing tasks' logs | without `--continue`, the first failure stops the rest, and their missing verdicts mean did not run; with it, every part runs and gets its line |

### The pipe trap

`bun test | tail -n 30` exits with `tail`'s status, so the suite's failure is
gone before anything reads it. `set -o pipefail` keeps the failing status
in bash and zsh, but it is off by default and a hook's shell is not always
the agent's; the wrapper captures the status from the command itself and
needs no shell option.

### Agent-runtime hooks

A runtime that can rewrite a command before it runs applies the wrapper
automatically; where it cannot, the quiet package script named in the
instruction file is the seam, and the agent runs it by convention.

| Runtime | Seam | Contract |
|---------|------|----------|
| Claude Code | a `PreToolUse` hook on the `Bash` tool | reads the tool call as JSON on standard input (`tool_input.command`), replies with `hookSpecificOutput.updatedInput.command` holding the rewritten command; it must not reply with a permission decision, since a rewrite is not a review of the command, and the rewritten call goes through the normal permission flow |
| any runtime | the quiet script (`test:quiet`, `lint:quiet`) the instruction file names | the agent runs it by convention; no rewrite |

The hook's safety model fails towards showing more, never towards hiding a
failure:

- it rewrites only a command that, trimmed, is a plain invocation of a
  known runner (an allowlist of exact prefixes, each followed by a space or
  the end), and the check for shell punctuation runs **before** the prefix
  match, so a rewrite can never start a second command;
- anything with a pipe, a redirect, a subshell, a quote, a newline or a
  background run passes through untouched, and so does an inspection flag
  (`--help`, a dry run, a collection-only run, a coverage or durations
  report, a watch or debugger mode): those outputs are the payload, and a
  tail of them would be wrong, not merely short;
- the rewritten command captures the exit status from the runner itself and
  bounds what it captures;
- a cancellation prints what was captured before re-raising the signal, so
  a run killed by the tool's own timeout leaves its diagnostics behind;
- the shell the wrapper hands the command to fails an argument that matches
  nothing (`failglob`), so a mistyped test path cannot pass as "no tests
  ran".
