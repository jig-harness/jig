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
run. And the agents collide with their own budgets: a clean test run
prints hundreds of lines an agent pays to read and learns nothing from,
while the filter that would quiet it (`| tail`) swallows the run's exit
status, so a red run comes out green. This module treats "N agents in
parallel" as a **designed-for condition** and engineers the collisions away
up front.

## Invariant

> Parallel agents sharing one machine are a supported mode, so the shared
> resources are partitioned deterministically rather than contended: each
> worktree gets a **deterministic port** derived from its identity; heavy
> build/test runs pass through a **cross-worktree mutex** (atomic, with a
> **CI bypass**, since a CI runner is already isolated); branches are
> **reused before created**; the shared-state footguns (`git stash` across
> worktrees, a root install with the wrong package manager, global git config)
> are **banned with a stated rationale**; each worktree's data lives in a
> **namespace derived from its identity**, created with an owner and an
> expiry and **reaped by that owner**; worktree **teardown nudges
> reflection** so a session's lessons reach the learning loop; and **no pull
> request edits a file every pull request edits**: a change's changelog entry
> and version bump are a **change note** of its own, which a release step
> writes into the changelog after the merge; and a **gate speaks to an
> agent** in a condensed voice on green and in full on red, keeping its own
> exit status, with one named verdict line per part.

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
7. **Per-worktree data namespaces** — several worktrees share one database
   server, so each derives its own namespace (a schema, a database, a key
   prefix) from its identity, the way it derives its port: the same worktree
   always gets the same name, and no two share one. The namespace is created
   with its owner and an expiry, and a report-first reaper, run by that
   owner, drops what has expired or whose worktree is gone, never the
   production namespace and never a namespace created without those keys
   (the missing key is the finding). The drop decides each name again under
   a lock the create also takes, since a worktree can come back on the same
   branch, and so to the same name, after the report.
   [`reference/worktree-namespace/`](reference/worktree-namespace/) derives
   the name and decides the plan; the per-database create and drop commands
   are in [mappings.md](mappings.md#per-worktree-data-namespaces). This is
   [M10's symmetric teardown](../M10-environments-deploy/README.md#environment-hygiene)
   applied on the developer's machine.

8. **Agent-facing gate output** — a gate command an agent runs is read by
   the agent, line by line, so its output is shaped for that reader. On
   success its **[quiet mode](../../GLOSSARY.md)** prints a summary (a
   [verdict line](../../GLOSSARY.md) and the last few lines); on failure it
   prints the full output; and it **keeps the gate's own exit status**,
   which a filter in a pipe (`| tail`, `| grep`) would replace with its
   own, turning a red run green. A run with several parts prints **one
   named verdict line per part**, and its reader treats a **missing verdict
   line as "did not run"**, never as passed, so a part that was skipped or
   a wrapper that died cannot pass by silence. The quiet form is a script
   of the repository's own (`test:quiet`, `lint:quiet`), so every agent
   runtime and every person runs the same one. A runtime that can rewrite
   a command before it runs (an agent hook) applies it automatically, under
   a safety model that fails towards showing more: it rewrites only a plain
   invocation of a known runner; leaves anything with shell punctuation, a
   pipe, a redirect, a background run or an inspection flag (`--help`, a
   dry run, a coverage report, a watch mode) untouched; bounds what it
   captures; and fails a mistyped test path instead of reporting that no
   tests ran. The portable wrapper is
   [`reference/quiet-run/`](reference/quiet-run/) (`quiet-run.ts` +
   self-test); the runners' own flags and the hook shape per runtime are in
   [mappings.md](mappings.md#agent-facing-gate-output).

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
  of its own, not as an edit to the changelog or the version; and the gate
  commands name a quiet invocation for agents (a reporter flag or a script),
  with the rule that no filter in a pipe stands between a gate and its exit
  status.
- **Standard** — deterministic per-worktree port allocation is **scripted**
  (mechanical, not eyeballed); the cross-worktree heavy-run mutex is **scripted
  with a CI bypass**; and worktree create/remove hooks are wired so the port slot
  is allocated on create and reflection is nudged on remove; where worktrees
  share a database, each worktree's **namespace is derived from its
  identity** and created with an owner and an expiry, and a report-first
  reaper drops the stale ones; and a release
  step **assembles the change notes after the merge**, one run at a time,
  while a check fails a malformed note or a direct edit to what that step
  writes; and the quiet form is **scripted**: a summary on green, the full
  output on red, the gate's own exit status, one verdict line per part.
- **Strict** — the port allocator and the resource lock each **ship a self-test
  that runs in CI**, so a broken utility fails loudly; the teardown hook's
  reflection nudge is wired to the [M8](../M8-learning-loop/) loop; and the
  footgun bans are **enforced where mechanizable** (e.g. a hook or lint that
  rejects the wrong package manager at the repo root); and the quiet wrapper
  ships a **self-test** proving a failing run keeps its status and prints in
  full, and the agent runtime applies it automatically where it has a hook
  for that, under the fail-towards-showing-more rule.

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
6. Where worktrees share a database, derive each worktree's namespace with
   [`reference/worktree-namespace/`](reference/worktree-namespace/) in the
   migration or dev command, write the owner and expiry when it is created,
   and give each owner the reaper's decision as a command that reports before
   it drops (commands per database in [mappings.md](mappings.md#per-worktree-data-namespaces)).
7. Where the repository keeps a changelog or a version that every pull request
   touches, move it to change notes: pick the tool for your ecosystem from
   [mappings.md](mappings.md) or use the plugin’s
   [`changelog` scripts](../../plugin/skills/changelog/scripts/README.md), run the release step
   on the integration branch after each merge, and the branch check on every
   pull request. Convert open pull requests' changelog edits into notes once.
7. Give each gate command a quiet form: a reporter flag from
   [mappings.md](mappings.md#agent-facing-gate-output) or
   [`reference/quiet-run/`](reference/quiet-run/) around it, named in the
   package scripts the instruction file lists; where the agent runtime has a
   command-rewriting hook, wire the wrapper there.

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
| [`reference/worktree-namespace/`](reference/worktree-namespace/) | The per-worktree data namespace: the name derived from a worktree's identity, and the reaper's decision (which of one owner's namespaces are expired or orphaned, which were created unlabelled, with production refused) |
| [`reference/quiet-run/`](reference/quiet-run/) | The quiet-run wrapper: a verdict line and the tail on green, everything on red, the command's own exit status; with its self-test |
| [`mappings.md`](mappings.md) | Worktree managers and agent runners, package managers, CI providers, change-note tools, per-database namespace commands, test-runner quiet flags and the command-rewriting hook per agent runtime |
| [maturity criteria](../../plugin/skills/audit/criteria/M12-parallel-agent-ergonomics.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Each reference utility is a Bun script with a self-test. The port allocator
and the resource lock stand alone; the namespace scripts import helpers from
the Jig repository's `lib/`, so run them from a pinned Jig checkout or vendor
`lib/` at the same place relative to them
([their README](reference/worktree-namespace/README.md)).

### Left out by design

- **Local values.** Port ranges, lock names, hook-manager wiring, the notes
  directory and the version files are each repository's own; the scripts
  take them as arguments or ship with neutral defaults.
- **Who may push the release.** Where the integration branch is protected,
  the release step's commit needs an identity allowed past that protection,
  or a release pull request that a person merges; which one is the
  repository's decision, and its CI provider's settings hold it.
- **Repositories without parallel agents.** The worktree practices
  (branches and footguns, ports, the heavy-run mutex, worktree hooks and
  namespaces, the teardown nudge) are **expected-absent** for a repository
  that never runs parallel agents on one machine: with a single checkout there
  is nothing to partition, so scoring them "absent" is correct, not a gap.
  The gate-output practices (the quiet form, its self-test, one verdict line
  per part) apply to any repository where an agent runs the gates, single
  checkout or not. The change-note criteria are expected-absent where no
  changelog or version changes with each pull request.

### Future

- **Probe-for-free port fallback** (walk to the next open port on a detected
  clash), described in the [port-allocator README](reference/port-allocator/);
  it is not shipped, to keep the allocator stateless and dependency-free.
- **A runnable workspace lifecycle**, and cross-worktree locks as shared
  tooling, are later work in the [roadmap](../../ROADMAP.md).
- **Garbage collection of a developer machine.** A sweep of what every
  worktree's sessions left behind (leftover processes, scratch directories,
  caches and containers keyed to worktrees that no longer exist), run by the
  owner with the same report-first rule as the namespace reaper, is designed
  and not yet validated in a working repository.
- **A copyable command-rewriting hook** that applies the quiet wrapper in
  an agent runtime: the contract and the safety model are in
  [mappings.md](mappings.md#agent-facing-gate-output), and each repository
  writes its own until a second runtime shows what two such hooks share.
- **Jig's own gate runner in the quiet form.** `scripts/gates.ts` runs each
  step with its full output and prints one line at the end, so Jig's record
  scores piece 8 absent; wrapping its steps in
  [`reference/quiet-run/`](reference/quiet-run/), one verdict line per step,
  is open work.
