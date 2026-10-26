# M12 mappings — per-ecosystem implementations

The module [invariant](README.md) — deterministic per-worktree ports, a
cross-worktree heavy-run mutex with a CI bypass, branch reuse-before-create,
change records of their own assembled after the merge, banned shared-state
footguns, gate output shaped for an agent, and a control channel into an
unattended agent, and measuring merge-conflict hotspots — is tool-independent. This file maps its mechanisms
onto concrete worktree managers / agent runners, package managers, and
[CI](../../GLOSSARY.md) providers. Replace `<placeholders>` with your values.

## The utilities, and where they plug in

The module ships portable scripts for the mechanisms below; the rest is
convention. Run the resource-lock script from a pinned Jig checkout, keeping
`plugin/shared/` at its relative path for the shared lock and process cleanup
registry. Point one variable at the module in that checkout and build
paths from it, exactly as the other modules do. The change-note commands
ship inside the plugin; run them from its installed cache with the consumer
repository as the working directory.

| Utility | Runs where | Signal it reads |
|---------|-----------|-----------------|
| `reference/port-allocator/allocate-port.ts` | worktree-create hook and/or the dev script | worktree id (arg or `WORKTREE_ID`), range via `PORT_BASE`/`PORT_SPAN` |
| `reference/resource-lock/with-resource-lock.ts` | around heavy local gate commands (build, test, e2e) | lock via `LOCK_NAME`/`--lock`; bypass via `CI`/`RESOURCE_LOCK_BYPASS` |
| [`changelog/scripts/release.ts`](../../plugin/skills/changelog/scripts/release.ts) | on the integration branch after every merge, one run at a time | the repository's `changelog:` configuration (notes directory, changelog, version files) |
| [`changelog/scripts/check.ts`](../../plugin/skills/changelog/scripts/check.ts) | in the branch gates | the base's `changelog:` configuration, plus `--base` |
| `reference/quiet-run/quiet-run.ts` | around each gate command an agent runs (a `test:quiet` script, or a runtime hook) | `--name` per part, `--tail` for the lines a green run shows |
| `reference/worktree-namespace/namespace-for-worktree.ts` | the migration or dev command, and the create hook | the worktree's branch (arg or `WORKTREE_ID`), `--prefix`, `--max-length` |
| `reference/worktree-namespace/find-stale-namespaces.ts` | the owner's reap command, before any drop | the inventory via `--inventory`, `git worktree list --porcelain` via `--live`, `--owner`, `--production` (required) |

## Worktree managers / agent runners — where the hooks wire

The create hook allocates and prints the port slot; the remove hook nudges
reflection and parks the worktree's unsent reflection findings. Both act on
the worktree they run in, so each runs inside its worktree. Only the wiring
point differs per tool.

| Manager | Create-hook point | Remove-hook point | Notes |
|---------|-------------------|-------------------|-------|
| plain `git worktree` | a wrapper script/alias around `git worktree add` | a wrapper around `git worktree remove` that changes into the worktree being removed, runs the remove hook there, and removes the worktree only when it succeeds | git itself has no add/remove hook event; the wrapper is the seam |
| Herdr | Jig's Herdr plugin ([`tools/herdr/plugin`](../../tools/herdr/README.md#the-worktree-hooks)) answers `worktree.created` by running `.config/worktree-hooks/create` inside the worktree the event names (`data.worktree.path` in `HERDR_PLUGIN_EVENT_JSON`); `tools/herdr/workspace.ts open` waits for it before starting an agent, and runs it itself where the plugin is not installed | `tools/herdr/workspace.ts remove` resolves the worktree, runs `.config/worktree-hooks/remove` inside it and parks its reflection findings on the machine that holds it, and removes it through `herdr worktree remove` only when both succeed | Herdr runs a plugin's commands in the plugin's own directory, so a create hook that read its working directory would give every worktree the same identity and port slot; `worktree.removed` fires after the checkout is gone, so it can only notify, never park |
| Orca | the [Orca workspace tool](../../tools/orca/README.md)'s `open` (the launcher's `orca` provider) runs `.config/worktree-hooks/create` inside the new worktree once its branch is named, before the agent starts, and marks the run in the worktree's git directory so it runs once; a worktree created in the Orca app runs Orca's own setup hook instead (Settings → Repository, or `scripts.setup` in the repository's `orca.yaml`), which can name the same file | `tools/orca/workspace.ts remove` runs `.config/worktree-hooks/remove` inside the worktree, parks its reflection findings when the clone is on this machine, and removes it through `orca worktree rm` only when both succeed; Orca's own delete runs an `orca.yaml` archive hook only when asked (`--run-hooks`) and has no other pre-remove point | Orca names a new branch after the worktree under its own prefix, so the tool renames it before the hook runs; Orca reads the branch from git and follows |
| another [workspace runtime](../../GLOSSARY.md) (such as Conductor) | the runtime's post-create / workspace-setup hook | the runtime's pre-remove / teardown hook | the runtime already brackets a session — the natural home for both |
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

## Control channels

The invariant: an unattended agent is reached through a closed set of
directives that code enforces and that fail closed, plus notes that only
advise. The mechanisms an agent runner already has cover part of that; the
table says which part.

| Mechanism | Binding directives | Advisory notes | Fails closed | Note |
|-----------|--------------------|----------------|--------------|------|
| [`drive-pr`'s drive mailbox](../../plugin/skills/drive-pr/SKILL.md#the-drive-mailbox) | `hold-push`, `pause`, `stop`, each with its `resume` | yes, read by choice with `mailbox.ts check` | yes: an unreadable inbox or directive holds the push and stops the loop | the reference; two append-only files under the worktree's `.context/drive-mailbox/` |
| A process signal (`SIGKILL`) | termination only, immediately rather than at a safe point | no | not applicable | the hard kill the channel exists to avoid needing |
| A runner's message to a running subagent (Claude Code's `SendMessage`) | none: the message enters the agent's context, and the agent decides | yes | no | suits a subagent in the same session; give it nothing it must obey |
| Typing into the agent's terminal (`tmux send-keys`) | none | yes, but as if the person typed it | no | free text with the force of a person's instruction, which is what keeping notes advisory prevents |

A runner's own messaging covers the notes; the directives need code at the
agent's checkpoints, whichever runner starts it.

The reference's layout: two append-only files in the worktree's scratch
directory (`.context/drive-mailbox/`), an inbox any sender appends to and an
outbox only the agent writes, recording what it has read and answered. Each
append takes a lock, so concurrent senders never interleave a line. A hold
sent while the push's own pre-push hooks run lands after the push's first
check; running `push-hold-recheck.ts` as the last pre-push hook command
closes that window
([drive-pr README § Push hold](../../plugin/skills/drive-pr/README.md#push-hold)).

## Change notes — per ecosystem

The invariant: no pull request edits a file every pull request edits. Each
change adds a note of its own, and one run at a time on the integration branch
writes the notes into the changelog and moves the version. The tools that do
it (the plugin's [`changelog` skill](../../plugin/skills/changelog/README.md),
Changesets, towncrier, scriv, changie), the ones that generate the changelog
from commits instead, and how the release reaches a protected branch are in
[M16's mappings](../M16-releases-versions/mappings.md), with the rest of the
release practice.

One neighbouring approach removes the conflicts without notes, and is not
enough: **a union merge driver** (`CHANGELOG.md merge=union` in
`.gitattributes`) lets git keep both sides of a local merge, but places lines
without knowing the changelog's sections, does nothing for the version, and
GitHub's mergeability check does not use it: the pull request still shows as
conflicting.

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

## Measuring merge conflicts

The invariant: a repository working in parallel measures where its merges
conflict, and each hotspot is removed at its cause or kept by a recorded
decision. This works across ecosystems because the evidence is in git.

Run the plugin command from its installed cache, with the repository as the
working directory (`<skill-dir>` is the installed `resolve-conflicts` skill):

```sh
bun <skill-dir>/scripts/history.ts --days 30 --json > <scratch>/merge-conflicts.json
```

| Source | What it observes | Limit to retain with the report |
|--------|------------------|---------------------------------|
| git replay (`history.ts`) | reachable merge commits, their conflicted paths and region causes; the `Conflicts resolved:` commit section adds decisions and reasons | requires git 2.43 or later (2.45 in a partial clone); never fetches; shallow boundaries can hide merges; squashed branches and rebase stops may leave no replayable merge |
| clone-local live record (`resolve-conflicts`) | resolutions of merges, rebases, cherry-picks and reverts, including time and whether `drive-pr` started them | events live in git's common directory and cover this clone only; no event does not mean no conflict |
| the repository's M11 event pipeline | the same conflict events sent through its own emitter | coverage depends on where that emitter runs; see [M11](../M11-process-observability/README.md) |

The replay does not read the live record. The replay JSON schema is
`merge-conflicts/v1`. Keep the window, scope, skipped
merges and cause-accuracy statement with the path rankings. The threshold
is `resolve_conflicts.hotspot_min_merges` (default 3). Choose a remedy from
the reported cause: derive counts, move release versions after the merge,
or keep entries in separate files; an overlapping change still needs a
decision about the work itself. Record the hotspot's cause, remedy or keep
decision, reason and revisit condition in the repository's learning loop.
Compare like windows after the change rather than treating an empty or
partial report as proof that the cause is gone.

## Machine resource collection schedules

The invariant is a daily report and a weekly collection, with explicit
executable paths and environment. The installed plugin copy owns the command;
a worktree checkout cannot host a job that may remove that checkout.
`bun --no-env-file --config=<plugin>/gc/bunfig.toml <plugin>/jig.ts gc install` previews the repository bounds and installs
on confirmation (`--yes`). See [the command](../../plugin/gc/README.md) for
its configuration, proof requirements and rollout limits.

| Platform scheduler | Installed file or entry | Cadence | See the last run | Remove |
|--------------------|-------------------------|---------|------------------|--------|
| macOS launchd | `~/Library/LaunchAgents/dev.jig.gc.plist` | `StartCalendarInterval.Hour`, from machine `gc.hour` | `launchctl print gui/<uid>/dev.jig.gc`; collection receipts | `gc install --uninstall --machine --yes` |
| Linux systemd user timer | `~/.config/systemd/user/jig-gc.service` and `jig-gc.timer` | `OnCalendar`, from machine `gc.hour` | `systemctl --user status jig-gc.timer`; `journalctl --user -u jig-gc.service`; receipts | `gc install --uninstall --machine --yes` |
| cron fallback | Current user's crontab, marked `# jig-gc` | Daily hour field from machine `gc.hour` | Collection receipts; scheduler's own mail or logs | `gc install --uninstall --machine --yes` |

The command chooses collection on machine `gc.collect_day` or under
`gc.min_free_bytes` pressure; other daily runs report. Removing one repository
keeps the job while another repository or machine-level kind remains.
