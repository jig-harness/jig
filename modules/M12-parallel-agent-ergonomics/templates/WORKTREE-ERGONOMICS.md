# Worktree ergonomics

> Copyable model. Drop this into your docs tree (e.g. `docs/development/`) and
> adjust the paths, port ranges, and package-manager names to your repo. It
> encodes one idea: **running N agents in parallel on one machine is a
> designed-for condition**, not an accident — so the resource collisions it
> causes are engineered away up front instead of debugged one confusing false
> failure at a time.

## The problem this prevents

Several AI agents (or several humans, or both) work the same repository at once,
each in its own [git worktree](https://git-scm.com/docs/git-worktree) — a
separate working directory on a shared checkout. On one machine they share
finite resources, and the collisions look like application bugs to an agent that
doesn't know another worktree exists:

- **Port clashes** — two dev servers or test listeners grab the same default
  port; the second dies with "address already in use".
- **Resource thrash** — three full build-and-test runs fire at once; all three
  slow down, caches fight, and flaky timeouts appear.
- **Shared git state** — a `git stash` in one worktree pops in another; a
  branch name collides; a global config edit leaks sideways.
- **Wrong-tool installs** — an install run at the repo root with the wrong
  package manager rewrites a lockfile every other worktree then trips over.
- **Shared-file pull requests** — every pull request adds its line to the top
  of the changelog and bumps the version, so each merge puts every other open
  pull request in conflict and costs it a resolution and another CI run.

## The rules

### 1. Deterministic per-worktree ports

Each worktree derives its port from its own identity (branch or directory name),
so the same worktree always gets the same port and two worktrees almost never
clash — no registry, no lock. Use the port allocator:

```sh
PORT=$(bun reference/port-allocator/allocate-port.ts "$(git branch --show-current)")
```

Give related services separate ranges (app on `PORT_BASE=20000`, database on
`21000`, …) so the only possible clash is within a service, and keep the span
well above your worktree count. Full caveats: the
[port allocator's README](https://github.com/docomply/jig/blob/main/modules/M12-parallel-agent-ergonomics/reference/port-allocator/README.md).

### 2. A cross-worktree mutex for heavy runs

Wrap heavy build/test commands so only one runs machine-wide at a time; the rest
wait their turn instead of thrashing:

```sh
bun with-resource-lock.ts --lock build -- pnpm build
bun with-resource-lock.ts --lock test  -- pnpm test
```

The lock is an atomic process-id symlink lock at a machine-global path (so it spans
worktrees) with a wait timeout and dead-holder reclaim. It **bypasses in CI**
(`CI=1`): a CI runner is already an isolated machine, so serializing there is
pure latency. Mechanism + caveats: `reference/resource-lock/README.md`.

### 3. Branch reuse before create

Before creating a branch, check whether the intended branch already exists
(locally or on the remote) and reuse it; only create when none exists. This
stops two agents opening divergent `feature/x` branches for the same task. The
short, importable rule and its checklist live in `branch-discipline.md`.

### 4. Footgun bans (with rationale)

Some conveniences are safe in a single checkout and dangerous across shared
worktrees. Ban them explicitly, and say **why** — a rule with a reason survives;
a bare prohibition gets worked around.

| Banned | Why it bites across worktrees | Do instead |
|--------|-------------------------------|------------|
| `git stash` to move work between worktrees | The stash stack is **shared** across all worktrees of a repo; a stash pushed in one can be popped in another, silently mixing or losing changes. | Commit to the branch (even a WIP commit) or use a per-worktree patch file. |
| Root-level install with the wrong package manager (e.g. `npm install` in a `pnpm` repo) | Rewrites the shared lockfile / hoists a divergent `node_modules`; every other worktree then rebuilds or fails on a lockfile it didn't change. | Use the repo's declared package manager only; install from the worktree, never hand-edit the root lockfile. |
| Editing global git config mid-session | `git config --global` leaks into every worktree and every other agent. (`--local` is **not** per-worktree either — it writes the shared repo config.) | For a per-worktree setting, enable `extensions.worktreeConfig` and use `git config --worktree key val`; for a single command, `git -c key=val …`. |

Keep the list short and repo-specific; each row is a real incident waiting to
happen, not a style opinion.

### 5. Teardown nudges reflection

When a worktree is removed, the work is freshest in memory — the ideal moment to
capture what was learned. The remove hook prints a short prompt to run your
reflection step (a `/reflect`-style command) so a session's lessons flow into
the learning loop rather than evaporating. This closes the loop with the
**[M8 learning loop](https://github.com/docomply/jig/tree/main/modules/M8-learning-loop)**: teardown is a reflection
trigger, and reflection feedback becomes durable improvements. Hook skeletons:
`worktree-hooks.md`.

### 6. Change notes instead of shared changelog edits

A pull request never edits the changelog's open sections or the version. It
adds a change note of its own (`changes/<branch>.md`) with its entry and the
release it needs (`patch`, `minor`, `major`, or none). After the merge, one
release run at a time on the integration branch writes the notes into the
changelog, moves the version and deletes the notes; a pull-request check
fails a malformed note and a direct edit to what that run writes. The
portable release step and check:
**[changelog scripts](https://github.com/docomply/jig/tree/main/plugin/skills/changelog/scripts)**;
the tools that do the same per ecosystem (Changesets, towncrier, scriv,
changie) are in the module's
**[mappings](https://github.com/docomply/jig/blob/main/modules/M12-parallel-agent-ergonomics/mappings.md)**.

## Adopt it

1. Vendor `reference/port-allocator/` and `reference/resource-lock/` (or copy the
   two scripts) and wire them per `worktree-hooks.md`.
2. Import the `branch-discipline.md` checklist into your agent instruction file
   (see the **[M0 instruction architecture](https://github.com/docomply/jig/tree/main/modules/M0-instruction-architecture)**
   module) so every agent inherits it.
3. Wrap your heavy gate commands with `with-resource-lock.ts` locally; leave CI
   unwrapped (the bypass handles it).
4. Add the footgun table above to your contributing docs, trimmed to your stack.
5. If every pull request edits a changelog or a version, move to change notes
   (rule 6) and convert the open pull requests' entries once.
