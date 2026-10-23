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
status, so a red run comes out green. And an agent left running unattended
is either running or killed: a person who wants it to hold a push for a
minute, pause while they look, or stop at a safe point has no way to say so,
so they kill it mid-step or let it carry on. This module treats "N agents in
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
> reflection** so a session's lessons reach the learning loop; **no pull
> request edits a file every pull request edits**: a change's changelog entry
> and version bump are a **change note** of its own, which a release step
> writes into the changelog after the merge; a **gate speaks to an
> agent** in a condensed voice on green and in full on red, keeping its own
> exit status, with one named verdict line per part; and an agent left
> running unattended can be reached through a **control channel** of its
> worktree, whose binding **directives** are a closed set enforced by code
> that **fails closed**, while free-text notes only advise; a repository
> working in parallel **measures where its merges conflict**, and removes
> each [conflict hotspot](../../GLOSSARY.md) at its cause or records why it
> keeps it.

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
   when a [change-area catalog](../M3-change-area-catalog/)'s validation plan
   clears it on *both* axes: it selects no heavy profile *including its
   fail-closed defaults* (an unmatched file, or a seeded area missing
   `validation.profile`, both select the deepest — never vacuously a shallow
   one), **and** the plan's sandbox requirement is clear: the remote-machine
   requirement a repository's own [composer](../../GLOSSARY.md) computes from
   the seeds' `impliedBy` closure, where it has one (see
   [mappings.md](../M3-change-area-catalog/mappings.md)). Profile depth alone
   is not enough to skip: it's seed-only by design, so a shallow seed set can
   still reach, purely through the closure, a dependent that needs the
   machine — only agreement on both axes means nothing heavy enough to need
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
   disjoint files, and no two claim the same version. What goes in a
   changelog, how the version is chosen and how a release is tagged and
   pushed is release practice, [M16](../M16-releases-versions/README.md)'s;
   this piece is only that no two pull requests edit the same lines for it.
   The plugin's [`changelog` skill](../../plugin/skills/changelog/README.md)
   is the runnable form of both; the tools that do the same per ecosystem
   are in [M16's mappings](../M16-releases-versions/mappings.md).
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
9. **A control channel into an unattended agent** — an agent left running
   on its own (a review loop driving a pull request to convergence for an
   hour, say) has only two states seen from outside: running, or killed. A
   person, or the session that started it, who notices a problem needs
   something in between: *do not push yet*, *pause*, *stop at the next safe
   point*, *here is context you may want*. The channel is scoped to the
   agent's worktree: a sender can leave a message on it while the agent
   runs, and the agent records what it has read, so a sender can tell a
   message seen from one lost. Its messages come in two kinds, and the split
   is the point:

   - **Directives** bind. They are a closed set (hold the push, pause, stop,
     and resume one of those), each enforced by code at named checkpoints,
     so the agent need not cooperate for one to take effect: a held push is
     refused immediately before it happens; a pause or a stop takes effect
     between rounds, never in the middle of one. A directive the agent
     cannot read counts as in force. A check made before an irreversible
     action must never read "no hold" from a file it could not parse.
   - **Notes** advise. They are free text the agent may read and is never
     obliged to act on. The power to bind is reserved for the closed set, so
     no note can change which directives are in force. That does not make a
     note's text safe: an agent that reads it has untrusted text in its
     context, and treats it as such.

   Adding a directive therefore means adding the code that enforces it at a
   stated checkpoint, never a sentence the agent is asked to obey. The
   channel belongs to one worktree, not to the machine: it is a
   conversation with *this* worktree's agent, so it is kept with that
   worktree (in its scratch, or in the runner that started the agent;
   [memory tiers](../M9-tasks-memory/templates/MEMORY-TIERS.md)). Jig's
   [`drive-pr`](../../plugin/skills/drive-pr/SKILL.md#the-drive-mailbox)
   skill ships it as the drive mailbox; its layout and the equivalents per
   agent runner are in [mappings.md](mappings.md#control-channels).

10. **Measure merge conflicts at their cause** — replay the merges in a named
    time window and rank the paths that conflicted, with their causes. A
    [conflict hotspot](../../GLOSSARY.md) is a path that meets the configured
    recurrence threshold (at least 3 merges by default). For each hotspot,
    remove the cause or record a decision to keep it, with a reason and a
    condition for revisiting it. Compare windows of the same length and scope before and after the
    remedy to see whether the cause stops. The
    [`resolve-conflicts` history report](../../plugin/skills/resolve-conflicts/SKILL.md#where-past-merges-conflicted-the-history-report)
    is the runnable form. It distinguishes files whose layout creates
    conflicts (shared counts, version lines or additions at the same place)
    from two changes to the same thing. Its replay sees reachable merge
    commits; the skill separately keeps a live record of rebases,
    cherry-picks and reverts resolved in this clone. Keep its coverage limits with the findings: silence from
    the live record is not proof of a conflict-free branch. Feed recurring
    causes into the existing [M8 learning loop](../M8-learning-loop/) rather
    than creating a second issue queue.

The whole copyable model — all its rules in one place, ready to drop into a docs
tree — is [`templates/WORKTREE-ERGONOMICS.md`](templates/WORKTREE-ERGONOMICS.md).
The branch-discipline block is written to be **imported into an agent instruction
file** (the [M0 instruction-architecture](../M0-instruction-architecture/) module
governs how those files layer), so every agent inherits the rules.

## Resource lifecycle

A machine-local resource is collected only when its lifecycle proves every
holder gone. Age is an additional guard, and unregistered resources or an
unreadable proof are findings to keep. A collector reports before collection,
checks the proof again at removal, and writes a receipt for report-only runs
as well as collections. Its creator and collector coordinate at the final
check; a tool's refusing removal protects only the conditions it checks.

[Jig's resource collector](../../plugin/gc/README.md) supplies the runner,
receipts, confirmed repository bounds, scheduler installation and adapters
for drive-pr state and scratch scopes. Scratch is report-only until fixture
registration covers every holder. Worktree reports evaluate lifecycle evidence; collection waits for the
operated reaper migration and session opener's shared lock. The machine policy
can tighten a repository declaration and cannot widen it.

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
  reaper drops the stale ones; a release
  step **assembles the change notes after the merge**, one run at a time,
  while a check fails a malformed note or a direct edit to what that step
  writes; the quiet form is **scripted**: a summary on green, the full
  output on red, the gate's own exit status, one verdict line per part;
  and where agents run unattended, each takes a **control channel** whose
  directives are enforced by code and fail closed; where work runs in
  parallel, dated merge-conflict reports name their window and coverage,
  and every hotspot has a remedy or a recorded decision to keep it.
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
   [M16's mappings](../M16-releases-versions/mappings.md) or use the plugin’s
   [`changelog` skill](../../plugin/skills/changelog/README.md) (`/jig:changelog
   setup` walks through it), run the release step
   on the integration branch after each merge, and the branch check on every
   pull request. Convert open pull requests' changelog edits into notes once.
8. Give each gate command a quiet form: a reporter flag from
   [mappings.md](mappings.md#agent-facing-gate-output) or
   [`reference/quiet-run/`](reference/quiet-run/) around it, named in the
   package scripts the instruction file lists; where the agent runtime has a
   command-rewriting hook, wire the wrapper there.
9. Where an agent runs unattended, give it a control channel: use
   [`drive-pr`](../../plugin/skills/drive-pr/SKILL.md#the-drive-mailbox)'s
   drive mailbox for review loops (with its push-hold recheck as the last
   pre-push hook command), or build the same closed set of directives into
   your own loop, each checked by code at a named checkpoint and failing
   closed ([mappings.md](mappings.md#control-channels)).

10. Where work runs in parallel, run the history report for a named window
    ([mappings.md](mappings.md#measuring-merge-conflicts)), retain its coverage
    statement, and record a remedy or a keep decision for every hotspot.
    Rerun it over comparable windows after a remedy lands.

## Status

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/WORKTREE-ERGONOMICS.md`](templates/WORKTREE-ERGONOMICS.md) | The copyable model: every rule, with the footgun table |
| [`templates/branch-discipline.md`](templates/branch-discipline.md) | The branch reuse-before-create rule and the footgun bans, written to be imported into an agent instruction file |
| [`templates/worktree-hooks.md`](templates/worktree-hooks.md) | Create-hook (allocate and print the port slot) and remove-hook (nudge reflection) skeletons |
| [`reference/port-allocator/`](reference/port-allocator/) | The deterministic per-worktree port allocator |
| [`reference/resource-lock/`](reference/resource-lock/) | The cross-worktree mutex for heavy runs, with its CI bypass (shared with [M1](../M1-gates-enforcement-ladder/)) |
| [`changelog` skill](../../plugin/skills/changelog/README.md) | The change note's procedure, the branch check that holds pull requests to it, and the release step that writes the notes in after the merge ([M16](../M16-releases-versions/README.md)'s runnable form too) |
| [`reference/worktree-namespace/`](reference/worktree-namespace/) | The per-worktree data namespace: the name derived from a worktree's identity, and the reaper's decision (which of one owner's namespaces are expired or orphaned, which were created unlabelled, with production refused) |
| [`reference/quiet-run/`](reference/quiet-run/) | The quiet-run wrapper: a verdict line and the tail on green, everything on red, the command's own exit status; with its self-test |
| [`drive-pr`'s drive mailbox](../../plugin/skills/drive-pr/SKILL.md#the-drive-mailbox) | The control channel into an unattended review loop: notes, and the `hold-push`, `pause` and `stop` directives with their checkpoints |
| [`resolve-conflicts` history report](../../plugin/skills/resolve-conflicts/SKILL.md#where-past-merges-conflicted-the-history-report) | A read-only replay: paths, causes, hotspots and coverage |
| [`mappings.md`](mappings.md) | Worktree managers and agent runners, package managers, CI providers, change notes and the union merge driver, per-database namespace commands, test-runner quiet flags and the command-rewriting hook per agent runtime, control channels |
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
- **The release itself.** Which changes get an entry, how the version is
  chosen, how a release is tagged and who may push it are
  [M16](../M16-releases-versions/README.md)'s.
- **Repositories without parallel agents.** The worktree practices
  (branches and footguns, ports, the heavy-run mutex, worktree hooks and
  namespaces, the teardown nudge) are **expected-absent** for a repository
  that never runs parallel agents on one machine: with a single checkout there
  is nothing to partition, so scoring them "absent" is correct, not a gap.
  The gate-output practices (the quiet form, its self-test, one verdict line
  per part) apply to any repository where an agent runs the gates, single
  checkout or not. The change-note criteria are expected-absent where no
  changelog or version changes with each pull request, and the
  control-channel criterion where no agent runs unattended. Merge-conflict
  measurement applies wherever people or agents work in parallel, including
  across machines; it is expected-absent only where work never runs in
  parallel.
- **A control channel the agent must obey in free text.** Notes stay
  advisory by design; see core piece 9.

### Future

- **Probe-for-free port fallback** (walk to the next open port on a detected
  clash), described in the [port-allocator README](reference/port-allocator/);
  it is not shipped, to keep the allocator stateless and dependency-free.
- **A runnable workspace lifecycle**, and cross-worktree locks as shared
  tooling, are later work in the [roadmap](../../ROADMAP.md).
- **Resource collection rollout.** The runner and first adapters are in
  [the plugin](../../plugin/gc/README.md). Moving in the operated worktree
  reaper and its opener's lock, validating the installed weekly sweep, and
  then adding container, branch and registered-process kinds remain in
  [roadmap item 24](../../ROADMAP.md), following
  [the design](../../design/resource-gc.md)'s build order.
- **A copyable command-rewriting hook** that applies the quiet wrapper in
  an agent runtime: the contract and the safety model are in
  [mappings.md](mappings.md#agent-facing-gate-output), and each repository
  writes its own until a second runtime shows what two such hooks share.
- **Jig's own gate runner in the quiet form.** `scripts/gates.ts` runs each
  step with its full output and prints one line at the end, so Jig's record
  scores piece 8 absent; wrapping its steps in
  [`reference/quiet-run/`](reference/quiet-run/), one verdict line per step,
  is open work.
