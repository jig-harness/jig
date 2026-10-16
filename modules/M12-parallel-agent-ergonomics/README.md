# M12 — Parallel-agent ergonomics

**What problem this solves.** Run several AI agents on one machine against one
repository — each in its own [worktree](../../GLOSSARY.md), a separate working
directory on a shared checkout — and they start colliding over the machine's
finite resources. Two dev servers grab the same port; three full test runs fire
at once and thrash the disk and caches; a `git stash` in one worktree pops in
another; two agents open divergent branches for the same task. The cruel part is
that these collisions **don't look like collisions** to an agent that doesn't
know another worktree exists — they look like application bugs ("address already
in use", a test that times out only sometimes, a lockfile that changed on its
own), so the agent misdiagnoses them and burns a session chasing a ghost. The collisions
continue past the machine: when every pull request adds its line to the top of
the changelog and bumps the version, each merge puts every other open pull
request in conflict, and each conflict costs a resolution and another full CI
run. This module treats "N agents in parallel" as a **designed-for
condition** and engineers the collisions away up front.

## Invariant

> Parallel agents sharing one machine are a supported mode, so the shared
> resources are partitioned deterministically rather than contended: each
> worktree gets a **deterministic port** derived from its identity; heavy
> build/test runs pass through a **cross-worktree mutex** (atomic, with a
> **CI bypass**, since a CI runner is already isolated); branches are
> **reused before created**; the shared-state footguns (`git stash` across
> worktrees, a root install with the wrong package manager, global git config)
> are **banned with a stated rationale**; worktree **teardown nudges
> reflection** so a session's lessons reach the learning loop; and **no pull
> request edits a file every pull request edits**: a change's changelog entry
> and version bump are a **change note** of its own, which a release step
> writes into the changelog after the merge.

Everything below is one tool-independent statement made mechanical; the
per-ecosystem wiring lives in [mappings.md](mappings.md).

## Core pieces

1. **Deterministic per-worktree ports** — each worktree derives its port from
   its own branch or directory name, so the same worktree always gets the same
   port and two worktrees almost never clash, with no registry and no lock. The
   portable allocator is [`reference/port-allocator/`](reference/port-allocator/)
   (`allocate-port.ts` + self-test); the collision caveat and range-sizing
   guidance are in its README.
2. **A cross-worktree heavy-run mutex** — full build/test passes run one-at-a-time
   machine-wide instead of thrashing, via an atomic process-id lock at a shared
   path (a symlink, or a hard link on Windows) with a wait timeout and
   dead-holder reclaim:
   [`reference/resource-lock/`](reference/resource-lock/) (`with-resource-lock.ts`
   + self-test). It **bypasses under [CI](../../GLOSSARY.md)** because a CI runner
   is an already-isolated machine — serializing there would be pure latency. This
   is the **same `with-resource-lock` mechanism** the
   [M1 gates & enforcement ladder](../M1-gates-enforcement-ladder/) module points
   to for putting heavy pre-push gates behind a mutex; M12 owns the script, M1
   consumes it. It can also be skipped locally — not just bypassed in CI —
   when a [change-area catalog](../M3-change-area-catalog/)'s `validation:`
   projection clears it on *both* axes it computes: the deepest profile is
   all-`shallow` *including its fail-closed defaults* (an unmatched file, or
   a seeded area missing `validation.profile`, both compute as `deep` —
   never vacuously `shallow`), **and** no area reached through the seeds'
   `impliedBy` closure declares `needsSandbox: true` (see
   [mappings.md](../M3-change-area-catalog/mappings.md)). Profile depth alone
   is not enough to skip: it's seed-only by design, so an all-`shallow` seed
   set can still reach a `needsSandbox` dependent purely through closure —
   only agreement on both axes means nothing heavy enough to need
   serializing ran.
3. **Branch reuse before create** — before creating a branch, look for an
   existing one (local or remote) and reuse it; only create when none exists, so
   two agents on the same task converge on one branch instead of forking two. The
   rule and its snippet are [`templates/branch-discipline.md`](templates/branch-discipline.md).
4. **Footgun bans with rationale** — conveniences that are safe in a single
   checkout but dangerous across shared worktrees are banned *with the reason
   attached* (a rule with a rationale survives; a bare "don't" gets worked
   around): no `git stash` to move work between worktrees (the stash stack is
   shared repo-wide), no root install with the wrong package manager (it rewrites
   the shared lockfile), no mid-session global git config. The table lives in
   [`templates/WORKTREE-ERGONOMICS.md`](templates/WORKTREE-ERGONOMICS.md) and the
   importable checklist in `branch-discipline.md`.
5. **Teardown nudges reflection** — the worktree-remove hook prints a prompt to
   run the reflection step while the session is freshest, so lessons flow into
   the [M8 learning loop](../M8-learning-loop/) instead of evaporating. The
   prompt is a nudge, never a blocker; what the hook does refuse is losing
   findings already captured in the worktree (with Jig's
   [`reflect`](../../plugin/skills/reflect/README.md) skill it parks them for
   the next reflection). Skeletons for both create and remove hooks are
   [`templates/worktree-hooks.md`](templates/worktree-hooks.md).

6. **Change notes instead of a shared changelog edit** — each pull request
   adds its changelog entry as a file of its own (a
   [change note](../../GLOSSARY.md)), saying which release it needs; it never
   edits the changelog's open sections or the version. After the merge, a
   release step on the integration branch, one run at a time, writes the
   notes into the changelog, moves the version to the largest bump asked for,
   and deletes the notes; a branch check fails a note the step could not read
   and a direct edit to what the step writes. Pull requests then touch
   disjoint files, and no two claim the same version. The plugin ships the
   [`changelog` scripts](../../plugin/skills/changelog/scripts/README.md) (`release.ts`,
   `check.ts` + self-test) for a
   [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) file; the tools
   that do the same per ecosystem are in [mappings.md](mappings.md).

The whole copyable model — all its rules in one place, ready to drop into a docs
tree — is [`templates/WORKTREE-ERGONOMICS.md`](templates/WORKTREE-ERGONOMICS.md).
The branch-discipline block is written to be **imported into an agent instruction
file** (the [M0 instruction-architecture](../M0-instruction-architecture/) module
governs how those files layer), so every agent inherits the rules.

## Maturity levels

- **Lite** — the branch reuse-before-create rule and the footgun bans are
  written down (a convention agents can follow), and a port-allocation
  convention exists (even if only "each worktree picks a port from this range");
  and a change records its changelog entry and version bump as a change note
  of its own, not as an edit to the changelog or the version.
- **Standard** — deterministic per-worktree port allocation is **scripted**
  (mechanical, not eyeballed); the cross-worktree heavy-run mutex is **scripted
  with a CI bypass**; and worktree create/remove hooks are wired so the port slot
  is allocated on create and reflection is nudged on remove; and a release
  step **assembles the change notes after the merge**, one run at a time,
  while a check fails a malformed note or a direct edit to what that step
  writes.
- **Strict** — the port allocator and the resource lock each **ship a self-test
  that runs in CI**, so a broken utility fails loudly; the teardown hook's
  reflection nudge is wired to the [M8](../M8-learning-loop/) loop; and the
  footgun bans are **enforced where mechanizable** (e.g. a hook or lint that
  rejects the wrong package manager at the repo root).

## Adoption steps

1. Copy [`templates/WORKTREE-ERGONOMICS.md`](templates/WORKTREE-ERGONOMICS.md)
   into your docs tree and trim the footgun table and port ranges to your stack.
2. Vendor [`reference/port-allocator/`](reference/port-allocator/) and
   [`reference/resource-lock/`](reference/resource-lock/); wrap your heavy gate
   commands with `with-resource-lock.ts` locally (CI is handled by the bypass).
3. Wire the create/remove hooks from
   [`templates/worktree-hooks.md`](templates/worktree-hooks.md) at your worktree
   manager's hook points (see [mappings.md](mappings.md)).
4. Import [`templates/branch-discipline.md`](templates/branch-discipline.md) into
   your agent instruction file so the reuse rule and bans travel with every
   agent.
5. Add the two self-tests to CI so the utilities can't rot silently.
6. Where the repository keeps a changelog or a version that every pull request
   touches, move it to change notes: pick the tool for your ecosystem from
   [mappings.md](mappings.md) or use the plugin’s
   [`changelog` scripts](../../plugin/skills/changelog/scripts/README.md), run the release step
   on the integration branch after each merge, and the branch check on every
   pull request. Convert open pull requests' changelog edits into notes once.

## Status

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/WORKTREE-ERGONOMICS.md`](templates/WORKTREE-ERGONOMICS.md) | The copyable model: every rule, with the footgun table |
| [`templates/branch-discipline.md`](templates/branch-discipline.md) | The branch reuse-before-create rule and the footgun bans, written to be imported into an agent instruction file |
| [`templates/worktree-hooks.md`](templates/worktree-hooks.md) | Create-hook (allocate and print the port slot) and remove-hook (nudge reflection) skeletons |
| [`reference/port-allocator/`](reference/port-allocator/) | The deterministic per-worktree port allocator |
| [`reference/resource-lock/`](reference/resource-lock/) | The cross-worktree mutex for heavy runs, with its CI bypass (shared with [M1](../M1-gates-enforcement-ladder/)) |
| [`changelog` scripts](../../plugin/skills/changelog/scripts/README.md) | The release step that writes change notes into a Keep a Changelog file and moves the version, and the branch check that holds pull requests to it |
| [`mappings.md`](mappings.md) | Worktree managers and agent runners, package managers, CI providers, change-note tools |
| [maturity criteria](../../plugin/skills/audit/criteria/M12-parallel-agent-ergonomics.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Each reference utility is a standalone Bun script with a self-test.

### Left out by design

- **Local values.** Port ranges, lock names, hook-manager wiring, the notes
  directory and the version files are each repository's own; the scripts
  take them as arguments or ship with neutral defaults.
- **Who may push the release.** Where the integration branch is protected,
  the release step's commit needs an identity allowed past that protection,
  or a release pull request that a person merges; which one is the
  repository's decision, and its CI provider's settings hold it.
- **Repositories without parallel agents.** The module is **expected-absent**
  for a repository that never runs parallel agents on one machine: with a
  single checkout there is nothing to partition, so scoring it "absent" is
  correct, not a gap. The change-note criteria are expected-absent where no
  changelog or version changes with each pull request.

### Future

- **Probe-for-free port fallback** (walk to the next open port on a detected
  clash), described in the [port-allocator README](reference/port-allocator/);
  it is not shipped, to keep the allocator stateless and dependency-free.
- **A runnable workspace lifecycle**, and cross-worktree locks as shared
  tooling, are later work in the [roadmap](../../ROADMAP.md).
