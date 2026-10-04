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
own), so the agent misdiagnoses them and burns a session chasing a ghost. This
module treats "N agents in parallel on one machine" as a **designed-for
condition** and engineers the collisions away up front.

## Invariant

> Parallel agents sharing one machine are a supported mode, so the shared
> resources are partitioned deterministically rather than contended: each
> worktree gets a **deterministic port** derived from its identity; heavy
> build/test runs pass through a **cross-worktree mutex** (atomic, with a
> **CI bypass**, since a CI runner is already isolated); branches are
> **reused before created**; the shared-state footguns (`git stash` across
> worktrees, a root install with the wrong package manager, global git config)
> are **banned with a stated rationale**; and worktree **teardown nudges
> reflection** so a session's lessons reach the learning loop.

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
   machine-wide instead of thrashing, via an atomic process-id symlink lock at a shared path
   with a wait timeout and dead-holder reclaim:
   [`reference/resource-lock/`](reference/resource-lock/) (`with-resource-lock.ts`
   + self-test). It **bypasses under [CI](../../GLOSSARY.md)** because a CI runner
   is an already-isolated machine — serializing there would be pure latency. This
   is the **same `with-resource-lock` mechanism** the
   [M1 gates & enforcement ladder](../M1-gates-enforcement-ladder/) module points
   to for putting heavy pre-push gates behind a mutex; M12 owns the script, M1
   consumes it.
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
   the [M8 learning loop](../M8-learning-loop/) instead of evaporating. It is a
   nudge, never a blocker. Skeletons for both create and remove hooks are
   [`templates/worktree-hooks.md`](templates/worktree-hooks.md).

The whole copyable model — all five rules in one place, ready to drop into a docs
tree — is [`templates/WORKTREE-ERGONOMICS.md`](templates/WORKTREE-ERGONOMICS.md).
The branch-discipline block is written to be **imported into an agent instruction
file** (the [M0 instruction-architecture](../M0-instruction-architecture/) module
governs how those files layer), so every agent inherits the rules.

## Maturity levels

- **Lite** — the branch reuse-before-create rule and the footgun bans are
  written down (a convention agents can follow), and a port-allocation
  convention exists (even if only "each worktree picks a port from this range").
- **Standard** — deterministic per-worktree port allocation is **scripted**
  (mechanical, not eyeballed); the cross-worktree heavy-run mutex is **scripted
  with a CI bypass**; and worktree create/remove hooks are wired so the port slot
  is allocated on create and reflection is nudged on remove.
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

## Port status

| Source (docomply `develop`) | Landed as |
|-----------------------------|-----------|
| Worktree-create hook allocating a deterministic port slot | [`reference/port-allocator/`](reference/port-allocator/) (portable allocator + self-test) and the create-hook skeleton in [`templates/worktree-hooks.md`](templates/worktree-hooks.md) |
| `with-resource-lock.ts` cross-worktree mutex (atomic process-id symlink, process-id liveness, stale reclaim, CI bypass) | [`reference/resource-lock/`](reference/resource-lock/) (transcribed and self-tested; shared with [M1](../M1-gates-enforcement-ladder/)) |
| Branch reuse-before-create discipline + footgun bans | [`templates/branch-discipline.md`](templates/branch-discipline.md) and the model doc [`templates/WORKTREE-ERGONOMICS.md`](templates/WORKTREE-ERGONOMICS.md) |
| Worktree-remove hook nudging reflection | remove-hook skeleton in [`templates/worktree-hooks.md`](templates/worktree-hooks.md), cross-linked to [M8](../M8-learning-loop/) |

Also landed: [`mappings.md`](mappings.md) (worktree managers / agent runners,
package managers, CI providers) and [`maturity.yaml`](maturity.yaml).

**Not ported** (per "don't port the unproven" / IP scrub): the reference
implementation's specific port ranges, lock names, and hook-manager wiring are
its local values, not a portable mechanism — groundwork ships the two scripts
with neutral defaults and leaves the values to each repo. The probe-for-free port
fallback (walk to the next open port on a detected clash) is noted as **future**
in the port-allocator README, not shipped, to keep the allocator stateless and
dependency-free. This module is **expected-absent** for repos that never run
parallel agents on one machine: with a single checkout there is nothing to
partition, so scoring it "absent" is correct, not a gap.
