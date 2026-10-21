# Resource garbage collection for a developer machine: design

**What problem this solves.** A machine that runs many agent
[worktrees](../GLOSSARY.md) at once fills up with what their sessions leave
behind: processes a test fixture spawned and never reaped, scratch
directories, container volumes and images keyed to worktrees that no longer
exist, branches whose pull requests merged weeks ago, and the state files the
tools themselves mint. Each kind is cleaned by its own script on its own
schedule, or by nobody, and none of them reports in the same form. Measured on
one developer laptop running such a fleet, with the host that runs its gates
idle and its forge answering in under two seconds, the machine itself was
the bottleneck: a load average of 190 on 16 cores with 0% idle, and the
leftovers below.

| Resource | Found | Cleaned by |
|----------|-------|------------|
| Container volumes | 598, 56 gigabytes reclaimable | nobody |
| Container images and build cache | 5 gigabytes reclaimable | nobody |
| Local branches merged into the base | 67 | nobody |
| `drive-pr` state directories | 3,603, of which 4 belonged to a clone on the machine | `reap-state.ts`, for the current clone only |
| Worktrees | 78 live, 17 with a merged pull request or idle past two months | the repository's own reaper, scheduled by its own per-platform installers |
| Remote gate workspaces on the gates host | 711, 259 gigabytes | a timer in the host's own configuration |
| Idle fixture processes adopted by init | 82, the oldest four hours old | a hand-written script, tracked nowhere |

With this built, one command reports what every registered kind of resource
would reclaim and why, collects on request or on a schedule, leaves a receipt
of what it did, and refuses whatever it cannot prove is dead. A repository
declares what it mints and how to tell it is still in use; a machine declares
when to sweep and how much to keep.

This is the design of [plan.md](plan.md) item 24. Existing collectors
each hold part of the contract below:
[`reap-state.ts`](../plugin/skills/drive-pr/scripts/reap-state.ts)
retires `drive-pr`'s own state on a lifecycle predicate, the
[namespace reaper](../modules/M12-parallel-agent-ergonomics/reference/worktree-namespace/README.md)
drops per-worktree data namespaces report-first, and
[`lib/test-tmpdir.ts`](../lib/test-tmpdir.ts) scopes a test run's scratch
so it can be removed by prefix. A working repository runs a worktree reaper
with scheduler installers for two platforms that this design moves in. M12
lists the whole as future work in its README.

## How it works

### The contract every collector obeys

Every [collection kind](../GLOSSARY.md) keeps one shape, and the shape is
the design; the kinds are instances of it. It is the target, not a
description of what exists: the collectors above each hold part of it, and
each adapts as it moves in. `reap-state.ts` gains receipts. The namespace
reaper keeps reaping on an expiry, because its expiry is a lease the owner
recorded at creation rather than an age the sweep infers, and the contract
counts a recorded lease as a lifecycle fact. `lib/test-tmpdir.ts` gains the
owner record its kind's predicate needs (build step 1); report mode,
receipts and the second decision come from the runner, not from the helper.

- **A [lifecycle predicate](../GLOSSARY.md) decides; age only guards.** A
  resource is collected because something proves it is dead: its pull
  request merged, its worktree is gone, its owner process exited, its
  container project has no container.
  Wall-clock age is an extra bound on top of that proof, never a substitute
  for it: an age-based sweep cannot prove that no observer still holds a
  reference, and `reap-state.ts` records why it rules one out.
- **Report first.** A run without `--collect` touches no resource and says,
  per resource, what it would do and on which proof; it still writes its
  receipt. The report is the same text
  the collecting run prints, so what was reviewed is what happens.
- **Fail closed.** A predicate that cannot be evaluated (a forge call that
  errors, an unreadable owner record, a process identity that cannot be read)
  leaves the resource alone and reports it as unverified, as the gates in
  [M1](../modules/M1-gates-enforcement-ladder/README.md) [fail closed](../GLOSSARY.md).
  A whole kind whose inventory cannot be enumerated reports that and exits 1;
  a run that collected nothing because nothing qualified exits 0.
- **Decide again at the drop.** A resource can come back between the report
  and the collection: a worktree reopens on the same branch, a process is
  respawned. The collecting run re-reads each resource's proof under a lock
  its creator also takes, the way the namespace reaper
  [decides at the drop](../modules/M12-parallel-agent-ergonomics/reference/worktree-namespace/README.md#from-decision-to-drop).
- **Refuse what is not registered.** A resource the repository did not
  declare, or that carries no owner record where one is required, is a
  finding, not a candidate: the missing registration is the defect to report.
  A production target is never a candidate in any kind.
- **Leave a receipt.** Every run writes one
  [collection receipt](../GLOSSARY.md) under `~/.local/state/jig/gc/<date>/`:
  the kinds swept, each resource collected with its proof and size, each one
  refused with its reason, and the exit status. A person who finds something gone can read why; a sweep that
  collected far more than usual is visible in the record before anyone
  notices on disk. Receipts are themselves a machine-level kind and the one
  exception to the first rule: a receipt is the runner's own output, nothing
  reads it but a person, and no resource depends on it, so there is no
  liveness to prove. They are kept for a configured number of days, and the
  receipt of the most recent run of each kind is never collected.

### Kinds, not commands

A repository cannot register a shell command as a collector. A command is a
cron job with a configuration file in front of it; it carries none of the
contract above, and the contract is what makes a sweep safe to run
unattended. A repository instead enables a **kind** Jig ships and gives it
the facts the kind's predicates need.

| Kind | The repository declares | Live when | Collected when |
|------|------------------------|-----------|----------------|
| Worktrees | the worktree roots, the base branch | the branch has an open pull request, or uncommitted or untracked changes, or commits that are on no remote branch and not in the history of its merged pull request's head as the forge records it (a squash merge leaves the topic commits outside the base's history, so ancestry alone cannot clear them), or an operation in progress (merge, rebase, cherry-pick, bisect) | no live condition holds (each one vetoes collection on its own), and its pull request merged, or closed with every commit on a remote branch (the branches kind keeps a closed-but-unmerged branch), or it has no pull request, is 0 commits ahead of the base and idle past the guard |
| Tool state | nothing: `drive-pr` registers its own state directory | a live lease, a pull request still open or closed-but-unmerged | the predicate `reap-state.ts` already applies, per clone on the machine rather than the current clone only |
| Scratch directories | the prefixes its tools use (`lib/test-tmpdir.ts`'s, a gate workspace prefix, a `.context/` path) | an owner recorded anywhere in its subtree, by captured identity, is alive: the directory's own owner, the owner of a child scope created inside it, or a process the owner registered (build step 4), so a root is never judged while a scope or fixture inside it may still be using it | no live owner and idle past the guard; a directory under no registered prefix is never a candidate, and one under a registered prefix with no owner record is a finding |
| Containers, volumes and images | the compose project names its worktrees derive, as the namespace reaper derives a schema name | a container of the project runs, or the project's worktree exists | the project's worktree is gone and no container runs; dangling images and build cache are a machine-level kind, since they belong to no repository, collected when the engine reports that no image or container references them, with age as the guard |
| Branches | the base branch, the forge | checked out in a worktree, or its pull request is open, or closed without merging | merged into the base and its remote branch gone; a closed-but-unmerged pull request is kept, since the forge lets it reopen |
| Processes | nothing: a tool registers the trees it starts | the registered owner is alive | the owner is gone and the tree still runs |

The processes kind deserves a word, because the obvious design is wrong. An
orphan is recognisable by its command line, and a sweep that matches command
lines against a list is easy to write and impossible to make safe: every
new fixture needs a new pattern, and a pattern that matches too much kills
somebody else's work. `drive-pr` already has the right primitive: a
[process registry](../plugin/shared/process-registry.ts) in which a tool
records the trees it starts, with captured identities so a reused pid is
never mistaken for the original
([ADR-0008](../docs/adr/ADR-0008-windows-cancellation-uses-captured-process-identities.md)).
The kind reaps registered trees whose owner is gone, and nothing else; a
test runner that spawns fixtures registers them (build step 4). Today's test
preload removes the run's scratch at the end of a run and reaps no
processes.

Each kind lives in its own module behind one interface: `inventory()`
lists the resources with their facts, `prove(resource)` returns the proof it
is dead or the reason it is not, `collect(resource)` removes it, and
`describe(resource)` gives the receipt line. The runner owns everything
else: the report, the lock, the second decision, the receipt, the exit
status. A kind's predicates are tested against fixtures, including the
cases that must be refused, and each new predicate is seen to refuse once
before its collection is trusted ([M14](../modules/M14-testing-strategy/README.md)).

### Two configuration layers

The repository and the machine answer different questions, so each has its
own layer, and neither can do the other's job.

**The repository** says what it mints and how to tell it is alive, in the
`gc` section of `.config/jig.yaml`: which kinds are enabled and the facts
each needs (worktree roots, the base branch, scratch prefixes, how a compose
project name is derived). These are facts about the repository's own
tooling, so they travel with it and every clone on every machine reads the
same declaration. Where a fact can be derived it is not asked for: the base
branch from `repository.base_branch` where the repository sets it and the
forge's default otherwise, the worktree roots from `git worktree list`,
the compose project from the compose file, the scratch prefix from the test
preload that sets it ([AGENTS.md § Writing conventions](../AGENTS.md#writing-conventions-mandatory),
derive before declaring). The declaration lists what the derivation could not
settle.

A declaration is deletion authority, so where it is read from matters. A
scheduled run never reads it from a worktree's checkout, where any branch
can widen it: it reads the declaration committed on the base branch's
remote tip, and collects only within the bounds `jig gc install` recorded in
the machine entry when a person confirmed it (the remote and the base branch
the declaration is read from, and the kinds, roots, prefixes and projects
shown at install). The remote and base branch are recorded, never re-derived
at run time: the derivation above runs once, at install, where a person sees
its answer, so a branch that changes `repository.base_branch` cannot redirect
a scheduled run to its own declaration. Changing either takes install again,
with confirmation. A base-branch declaration wider than the
recorded bounds is reported as a finding, and the widened part is not
collected until install is run again and confirmed.

**The machine** says when and how much, in the `gc` section of
`$HOME/.jig/jig.yaml` (`$JIG_HOME/jig.yaml` when set), the same file the
issue tracker's taxonomy path already lives in: the schedule, the idle guards
per kind where the machine wants them longer than the kind's default, disk
thresholds that turn a report into a collection, the repositories to sweep,
and the machine-level kinds that belong to no repository (dangling images,
build cache, receipts). The machine layer can tighten a repository's
declaration (a longer guard, a kind disabled) and never widen it: it cannot
enable a repository-keyed kind the repository did not declare, and it cannot
add a prefix or a project the repository did not name. The reason is the
contract's last rule: only the repository knows what it mints.

**The install command writes the machine entry from the repository's
facts.** `jig gc install`, run from a clone, derives what it can, shows the
entry it would add for that repository, and writes it on confirmation. This
is the "hint": the repository never writes into `$HOME`, and the person never
copies values by hand. The same command installs or refreshes the scheduler
job (below) and prints what it did.

### The run

`jig gc` is the one entry point:

- `jig gc` reports, for every enabled kind of every configured repository
  and every machine-level kind, what a collection would do and on what proof.
  `--kind <name>` and `--repo <path>` narrow it; `--json` emits the report
  in the receipt's own schema.
- `jig gc --collect` collects after the second decision, writes the
  receipt, and prints the same report with each line's outcome.
- `jig gc receipts` lists the receipts, and `jig gc receipts <date>` prints
  one.
- `jig gc install` is the installer above; `--uninstall` removes this
  repository's machine entry, and the shared job only once no repository
  entry and no machine-level kind is left; `--uninstall --machine` removes
  the job and every entry.

Exit status follows `reap-state.ts`: 0 when the run ran (whatever it found),
1 when a kind could not be enumerated or a collection failed part-way (the
receipt names what was and was not done), 2 for bad arguments, so a
scheduler that pages on a non-zero status pages on the right thing.

The run holds the machine's heavy-run lock
([M12's resource lock](../modules/M12-parallel-agent-ergonomics/reference/resource-lock/README.md))
while it collects, so a collection never races a gate run that is creating
the very scratch it would judge.

### Scheduling

Jig ships no scheduler; every platform has one, and each needs a different
file. The install command writes the job for the scheduler it finds, and
M12's `mappings.md` gets one row per scheduler with the file, the cadence
field, how to see the last run and how to remove the job: launchd on macOS,
a systemd user timer on Linux, cron where neither is present. Two lessons
from the working repository's installers are kept: the job runs the installed
plugin's copy of the command, never a worktree's checkout, because a worktree
can be reaped out from under its own scheduled job; and the job's environment
is written into the job file, since a scheduler starts no login shell and
inherits nothing from the shell that installed it.

The schedule is coarse by design: the job runs daily, collects weekly, and
on the other days only reports, with the report available any time by hand.
A machine under disk pressure can set a free-space threshold; a daily run
that finds the disk below it collects instead of only reporting. Nothing in
this design sweeps on every run of anything.

## Build order

Each step is one pull request, shippable alone, and each later step waits
until the one before it has run for real in a working repository (Jig's
"leave the unproven out" disposition).

1. **The runner and the kinds that exist.** `jig gc` with report, collect,
   receipts and install; the kind interface; the worktrees kind moved in from
   the working repository (its reaper and both scheduler installers, with
   their tests, deleted there in the same rollout: move, never copy); the
   tool-state kind wrapping `reap-state.ts` across every clone on the
   machine; the scratch kind over `lib/test-tmpdir.ts`'s prefix, with the
   helper writing an owner record (the creating process's captured
   identity) beside each directory it creates, child scopes included, under
   the lock the collector takes to decide at the drop. The scratch kind only
   reports until step 4: a dead owner may have started a fixture that still
   uses the directory, and until the test runner registers its fixtures no
   record proves it did not; age would be deciding, not guarding. Directories leaked before that record
   existed are reported as findings, not collected. The
   `gc` sections in both configuration layers, documented in
   `CONFIGURATION.md`. M12's README and `mappings.md` gain the practice and
   the scheduler rows; the audit gains a criterion for a repository that
   declares its kinds. Done when the working repository's weekly job is the
   installed one and its own installers are gone.
2. **Containers, volumes and images.** The compose-project kind, bound to the
   container engine's command-line client behind the kind interface (one
   implementation; a second engine when a repository needs it), and the
   machine-level dangling-images and build-cache kind. Done when, on a
   machine with volumes left by removed worktrees, the report names each
   eligible volume's project and the worktree it belonged to, and the
   collection reclaims every one of them, checked against the engine's own
   inventory afterwards.
3. **Branches.** Merged into the base and gone from the forge, never checked
   out, closed-but-unmerged kept. Done when the local branch count of a
   clone tracks its open pull requests.
4. **Processes.** The registry generalised from `drive-pr` to a shared
   module any tool can record into, the test runner registering its
   fixtures, the kind reaping registered trees whose owner is gone, and the
   scratch kind collecting as well as reporting. Done
   when the orphan count on a machine running the suite in several
   worktrees stays at zero without a hand-written sweep.

## Left out

- **Age-based sweeps.** No kind collects on age alone, receipts aside (the
  exception the contract names), for the reason
  `reap-state.ts` gives: age cannot prove nobody holds a reference, and a
  sweep built on it trades a leak for a race.
- **Repository-supplied collectors.** A `command:` field would make the
  framework a scheduler with a configuration file; the contract would hold
  only as far as each author remembered it. A repository that needs a kind
  Jig lacks contributes the kind.
- **Sweeping by size.** Nothing is collected because it is large. Size is in
  the report and the receipt so a person can act on it; the predicate is
  always the lifecycle.
- **Remote branches, remote images, cloud resources.** The collector reaches
  what is on the machine it runs on. Remote branches belong to the forge's
  own delete-on-merge setting; an environment's resources belong to
  [M10](../modules/M10-environments-deploy/README.md)'s environment
  lifecycle.
- **Continuous integration runners.** A runner is an isolated machine that
  is discarded after the job; there is nothing to collect across runs, as
  there is nothing to lock (M12's resource lock bypasses there for the same
  reason).
- **Scanning the whole filesystem.** Only registered prefixes are
  candidates. A scan of everything under `$HOME` would find more and prove
  nothing about any of it.
