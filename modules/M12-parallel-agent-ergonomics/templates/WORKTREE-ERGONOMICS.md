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
[port allocator's README](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/reference/port-allocator/README.md).

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
**[M8 learning loop](https://github.com/jig-harness/jig/tree/main/modules/M8-learning-loop)**: teardown is a reflection
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
**[changelog scripts](https://github.com/jig-harness/jig/tree/main/plugin/skills/changelog/scripts)**;
the tools that do the same per ecosystem (Changesets, towncrier, scriv,
changie) are in the module's
**[mappings](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/mappings.md)**.

### 7. Per-worktree data namespaces

Worktrees that share one database server each get their own namespace (a
schema, a database, a key prefix) derived from the worktree's branch, the
way its port is: the same worktree always gets the same name and no two share
one.

```sh
NS=$(bun reference/worktree-namespace/namespace-for-worktree.ts "$(git branch --show-current)")
```

The namespace is created **with its owner and an expiry** (a comment on the
schema, a row in a registry table), and each owner's reaper drops what has
expired or whose worktree is gone, **after reporting and never the production
namespace**: production has no prefix and needs an explicit flag to be
targeted at all. The drop decides each name again under a per-name lock the
create also takes, because a worktree can come back on the same branch, and
so to the same name, between the report and the drop. A namespace created without an owner or expiry is reported,
not reaped. The decision script and the per-database commands:
**[reference/worktree-namespace](https://github.com/jig-harness/jig/tree/main/modules/M12-parallel-agent-ergonomics/reference/worktree-namespace)**
and the module's
**[mappings](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/mappings.md)**.

### 8. Gate output written for an agent

An agent reads a gate's output line by line, so a clean run that prints
every passing test spends the agent's budget on nothing, and the obvious
filter (`| tail`) replaces the run's exit status with its own, so a red run
comes out green. Each gate command has a quiet form, a script of the
repository's own (`test:quiet`, `lint:quiet`): on success it prints a
verdict line and the last few lines, on failure the full output, and it
exits with the gate's own status, taken from the command itself and never
from a pipe. A run with several parts ends each with one named verdict
line; a part without one did not run, and never counts as passed. The
portable wrapper:
**[reference/quiet-run](https://github.com/jig-harness/jig/tree/main/modules/M12-parallel-agent-ergonomics/reference/quiet-run)**;
the runners' own flags and the shape of a hook that applies the wrapper in
an agent runtime are in the module's
**[mappings](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/mappings.md#agent-facing-gate-output)**.

### 9. A control channel into an unattended agent

An agent left running on its own (a review loop driving a pull request for
an hour, say) is otherwise either running or killed. Give it a channel kept
with its worktree that a person or the session that started it can write
to while it runs, in two kinds of message:

- **Directives** bind: a closed set (hold the push, pause, stop, and resume
  one of those), each checked by code at a named checkpoint, so the agent
  need not cooperate. A held push is refused immediately before it happens;
  a pause or a stop takes effect between rounds. A directive that cannot be
  read counts as in force.
- **Notes** advise: free text the agent may read and never has to act on.
  A note cannot change which directives are in force, and its text is
  untrusted input to the agent that reads it, like any other text it did
  not write.

A new directive comes with the code that enforces it, never as a sentence
the agent is asked to obey. The runnable form for review loops is the
drive mailbox of
**[Jig's drive-pr skill](https://github.com/jig-harness/jig/blob/main/plugin/skills/drive-pr/SKILL.md#the-drive-mailbox)**;
its layout and the alternatives per agent runner are in the module's
**[mappings](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/mappings.md#control-channels)**.

## Adopt it

1. Vendor `reference/port-allocator/` and `reference/resource-lock/` (or copy the
   two scripts) and wire them per `worktree-hooks.md`.
2. Import the `branch-discipline.md` checklist into your agent instruction file
   (see the **[M0 instruction architecture](https://github.com/jig-harness/jig/tree/main/modules/M0-instruction-architecture)**
   module) so every agent inherits it.
3. Wrap your heavy gate commands with `with-resource-lock.ts` locally; leave CI
   unwrapped (the bypass handles it).
4. Add the footgun table above to your contributing docs, trimmed to your stack.
5. If every pull request edits a changelog or a version, move to change notes
   (rule 6) and convert the open pull requests' entries once.
6. If worktrees share a database, derive each one's namespace (rule 7) in the
   migration command, write owner and expiry on create, and give every owner
   the reap command.
7. Give each gate command a quiet form (`test:quiet`, `lint:quiet`) by
   wrapping it with `quiet-run.ts` or the runner's own flag, name it in the
   instruction file as what agents run, and keep the gate's exit status out
   of any pipe (rule 8).
8. If an agent runs unattended, give it a control channel (rule 9): the
   drive mailbox for review loops, with its push-hold recheck as the last
   pre-push hook command, or the same closed set of directives built into
   your own loop.
