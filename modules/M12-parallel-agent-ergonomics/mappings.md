# M12 mappings — per-ecosystem implementations

The module [invariant](README.md) — deterministic per-worktree ports, a
cross-worktree heavy-run mutex with a CI bypass, branch reuse-before-create, and
banned shared-state footguns — is tool-independent. This file maps its mechanisms
onto concrete worktree managers / agent runners, package managers, and
[CI](../../GLOSSARY.md) providers. Replace `<placeholders>` with your values.

## The two utilities, and where they plug in

The module ships two portable scripts; everything else is convention. Point one
variable at wherever you vendored the module and build paths from it, exactly as
the other modules do.

| Utility | Runs where | Signal it reads |
|---------|-----------|-----------------|
| `reference/port-allocator/allocate-port.ts` | worktree-create hook and/or the dev script | worktree id (arg or `WORKTREE_ID`), range via `PORT_BASE`/`PORT_SPAN` |
| `reference/resource-lock/with-resource-lock.ts` | around heavy local gate commands (build, test, e2e) | lock via `LOCK_NAME`/`--lock`; bypass via `CI`/`RESOURCE_LOCK_BYPASS` |

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
