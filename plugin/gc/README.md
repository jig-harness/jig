# Resource collection

Agent sessions leave scratch directories and tool state on a developer
machine. A collector needs evidence that their owners have finished before it
removes anything. `jig gc` reports that evidence, refuses uncertainty, checks
again before collection, and leaves a receipt for every run.

It is a component of the plugin's [`jig` command](../README.md#the-jig-command),
which `jig install` puts on `PATH`. Before that, run it from the installed
plugin copy as `bun --no-env-file --config=<plugin>/gc/bunfig.toml
<plugin>/jig.ts`, with `<plugin>` the copy's absolute path. Either way the
trusted configuration prevents a checkout's Bun preloads and environment
files from running before collection.

```sh
jig gc
jig gc --repo <repository> --kind scratch --json
jig gc --collect
jig receipts gc
jig install gc --repo <repository>
jig status gc
jig gc --help
```

`jig gc --help`, `jig install --help` and `jig receipts --help` list each
form's options, and `jig completion <shell>` prints a completion script for
bash, zsh, fish, PowerShell (`pwsh`) or Nushell (`nu`).

`jig install gc` prints a preview. Repeat with `--yes` to confirm the
bounds and write the machine entry and daily scheduler job. `jig uninstall
gc` removes this repository's entry; the job stays while any repository or
machine kind remains. `jig uninstall gc --machine` removes every entry and
the shared job. Each operation previews before `--yes`. The form
`jig gc install [--repo <repository>] [--uninstall [--machine]] [--yes]`
does the same and keeps working. A checkout can run reports; scheduling
requires an installed copy that a worktree reaper cannot remove.

The repository declares kinds in `.config/jig.yaml`. The machine file
controls the schedule, retention and longer idle guards. Collecting runs
fetch the declaration from the install-recorded base branch and remote URL,
refusing when a URL rewrite rule redirects that URL; only the intersection
with confirmed install bounds is authorized. After upgrading to a version
that adds a regenerable-path default, every existing installation must preview
and confirm `jig install gc --repo <repository> --yes`, even without changing
its repository configuration: older installed bounds deliberately grant no
authority for that new default. A confirmed `worktrees` kind
covers the agent tool's directory in the clone's primary checkout
([below](#worktrees-an-agent-tool-makes)) as well as the confirmed roots. Git hooks and the file-system
monitor are disabled for these calls; transport and credential settings the
user configured (an SSH command, a credential helper) apply as they do to the
user's own fetches. See
[configuration](../CONFIGURATION.md#gc).

| Kind         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool-state` | Runs drive-pr's state reaper in report mode for each configured clone: the files a clone keeps beside the drive's database that the reaper would retire. Receipts retain its full per-family proof. Collection remains disabled until state creators hold shared admission across every state use; the reaper's lock excludes only other reapers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scratch`    | Inventories only declared directory prefixes. Owner records include captured process creation identities; a live owner anywhere in the subtree keeps the root. Where the identity cannot be captured (no readable process table), the record says so and the root is kept as unverified. Missing ownership is a finding. Registered test scopes can be collected only when their persistent registration proves every holder gone; incomplete registrations and other scratch remain report-only.                                                                                                                                                                                                                                                                                                                  |
| `worktrees`  | Reports Git changes, hidden index flags, operations, pull request state, remote commit coverage, process holders and idleness. The primary checkout and paths outside declared roots are excluded, except the worktrees an agent tool makes inside the clone ([below](#worktrees-an-agent-tool-makes)). Ignored local content needs preservation evidence unless a rule accounts for it ([below](#ignored-content)); the receipt lists every path set aside and the rule that set it aside. A worktree [Orca](https://www.onorca.dev) manages is marked `runtime: orca` and collected through Orca ([below](#worktrees-orca-manages)); an agent tool's worktree is marked `runtime: agent-tool` and collected with git; any other eligible worktree remains report-only until the opener shares session admission. |
| `receipts`   | Machine kind; removes receipts past retention while preserving the latest completed report for each repository and kind. Unfinished receipts and runs whose inventory failed never take that place. Removes the one-time archives of collected worktrees' ignored content past the same retention.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `orca-terminals` | Machine kind, planned when the machine entry names Orca's command (`orca.command`); closes [run tabs](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) whose run was killed before it closed its own tab, and parked run tabs nobody returned to ([below](#run-tabs)). |

Scratch creators use `shared/gc-lock.ts` to hold shared admission while
creating a scope and writing its owner record. Collectors take exclusive
admission across the final proof and removal. Each admission token holds its
creator's [process identity](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(`shared/liveness.ts`). An abandoned admission token blocks collection and
needs inspection; it is never stolen on age, and the refusal names its
creator and why that creator counts as gone.
Worktree openers have not adopted that protocol, so clean or merged worktrees
are reported only, except those a workspace runtime manages and those an
agent tool makes.

The process-holder check asks `lsof` which processes have files open under
the worktree. `lsof` warns about every mount it cannot read, whatever path
it was asked about (a desktop's document portal, a container's mounts); a
warning about a mount that neither holds the worktree nor lies inside it is
set aside. A warning about the worktree's own mount or one inside it,
anything else `lsof` reports as an error, or a run that was killed leaves
the holders unknown and the worktree `unverified`.

### Ignored content

Ignored content is the one part of a worktree git cannot give back: an
environment file or a note may be the only copy. A worktree with ignored
content no rule accounts for is a `finding`, and its reason names the paths.
A rule accounts for content through a rebuildable dependency, a mark the
writer left, or a repository declaration:

- **`dependency`**: a detected package manager's dependency directory
  (`node_modules`, wherever it sits in the tree), rebuilt from the root
  `package.json` and the tracked lockfile; listed as `rebuildable`.
- **`regenerable-path`**: a literal path in `gc.regenerable_paths`, read from
  the base branch and bounded by the installed declaration. It covers only
  that path and its descendants. The default is `[.fallow]`, the unused-code
  tool cache Jig's gates create. An explicit list replaces the default; add
  a build output such as `dist` only when it can be rebuilt. Refresh the
  installed collector after widening this list. Existing installations must
  also refresh after upgrading to a version that adds the default. Absolute paths, traversal,
  globs, Git metadata and `.context/` outside `.context/scratch/` are refused.
- **`cache-tag`**: a directory holding a `CACHEDIR.TAG` file that starts with
  the [cache directory tag](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  signature. Other tools tag their caches this way, and so do Jig's scripts
  for the working directories they keep under `.context/` (the drive's
  mailbox, foreground waits, intent chains, refocus state).
- **`jig-scratch`**: `.context/scratch/`, where Jig's procedures write the
  files they never need again.
- **`drive-handoff`**: a drive's handoff (`.context/pr-drive-<PR>.md`) that
  carries the machine block the drive writes in its first lines. Its
  narrative part is the drive's notes on rounds of a pull request that is
  merged or closed by the time gc removes the worktree.
- **`empty`**: a directory with nothing in it.

A link is never followed, so a link named like a marked directory, or a tag
that is a link, marks nothing. Anything else under `.context/`, such as a
facet move's record a procedure tells a person to keep, still vetoes. The
receipt's `details.setAside` lists each path a rule set aside with its rule,
and `details.rebuildable` the dependency directories.

**Worktrees made before marking.** Marking covers what was written after
Jig's procedures began to mark their working files, so a worktree made
earlier holds unmarked files of the same kind. The first run of a `jig gc`
that knows the marks records the time in `~/.local/state/jig/gc/marking-since`;
a worktree whose creation (the time of its `commondir` file in git's
administrative directory) is older than that gets a one-time archive instead
of the veto. Right before removal, after the remove hook, the park and the
last registry read, gc copies the ignored content no rule accounts for into
`~/.local/state/jig/gc/archives/<date>/<archive>/`, links as links, checks
that the copy holds as many entries and bytes as the source, and writes the
archive's manifest beside it. A worktree whose content is larger than
`gc.archive_max_bytes` (64 MiB by default; 0 archives nothing), whose
creation time cannot be read, or whose copy fails or does not match, is
kept. A report shows the planned archive in `details.archive` and its
reason; the receipt of a collected worktree names the archive's path. Archives expire with
the receipts: the `receipts` kind removes one once `gc.receipts_days` have
passed since it was written (by its manifest, or by its day directory when
the copy was cut short before the manifest).

### Test scratch

`--kind scratch` selects a kind; it does not grant access to the system's
temporary directory. Declare the directory-name prefix in the repository's
`gc.scratch_prefixes`, include `scratch` in `gc.kinds`, and install or refresh
the collector so its confirmed bounds include that prefix. For Jig's test
scopes on a host whose system temporary directory is `/tmp`, the prefix is
`/tmp/jig-test-tmp.`. Other hosts use their actual temporary directory.
Report the declaration before enabling collection:

```sh
jig gc --repo <repository> --kind scratch --json
```

Jig's test preload records scopes and child launches outside the disposable
scope. Those records survive a killed test runner and can identify a scope
that a surviving child recreated without its original owner file. The
collector still inspects only roots within the declared prefixes.

A participating Bun child records its own identity and further launches
before running fixture code. Participation requires the current Bun
executable, `--no-env-file` and an explicit empty `--config`. The launcher
pins a private configuration snapshot before execution. This path supports
direct file or evaluation programs without additional application arguments.
Unsupported startup
options, nested test runners, shell commands and workers leave unresolved
records. A dead parent or a sampled process table never clears that
uncertainty. The collector reports that reason and keeps the scope. Legacy
scopes and other scratch remain report-only.

Collection requires a complete registration, verified process identities,
and the configured idle guard. Process cleanup and directory removal are
separate receipt entries. Once the registered runner has exited, collection
can reap its registered children. The directory stays until another proof
confirms every holder gone. The collector checks again under exclusive
scratch admission before each action. It does not sweep at test startup or
use age as ownership evidence.

The registrations themselves are read in bounded pages: each run reads up to
100,000 registration folders, or as many as it reads in 30 seconds, and a
collecting run resumes the next one where it stopped, so a store of any size
is read in full over successive collecting runs. A report run reads the page
the next collecting run will start from and leaves that position alone. A folder that cannot
be read as a registration gets an `unverified` receipt line of its own, and
the rest of the page goes on. Removing a root that still exists needs the
whole store read in one bounded pass, as before; until the store fits one,
those roots stay.

A registration whose every root is gone has nothing left to remove, so it is
retired on lighter evidence than a root: every registered process has exited
and no launch still waits for its child's acknowledgement. An opaque launch
does not keep it, unless a scratch scope that still exists encloses its root,
whose own proof still counts that launch. Retirement runs under the same
exclusive scratch admission, at most 500 registrations per receipt line,
and the line names each registration it retired.

### Worktrees an agent tool makes

Claude Code's agent tool gives each isolated subagent a worktree of its own
under the clone's primary checkout, in `.claude/worktrees/`. No declared root
holds that directory and no runtime keeps a record of the trees in it, so
without this rule they pile up, and one still on a pull request's branch
holds that branch: no other worktree can check it out, and a workspace
manager makes a `<branch>-2` workspace instead. The kind derives the
directory from the clone's primary checkout, whatever roots the repository
declares, and marks each tree in it `runtime: agent-tool`.

The agent tool holds no session admission and keeps no registry, and a
subagent at work rarely shows as a process inside its tree (the session
running it has its working directory elsewhere), so what admits these trees
is the idle guard: nothing in the tree, and no entry in its `HEAD` log in the git
directory, changed for `idle_days`, and no process holds it. What makes removal safe is the rest of
the proof, which applies unchanged: a tree is
collected only when it is clean (no changes, hidden index flags, operation in
progress or ignored content no rule accounts for), no open pull request
holds its branch or commit, and its commits are on a remote branch or under
a merged pull request's head. A clean tree that has no pull request and no
commit the base lacks is collected too, where a tree of another opener is a
finding. Collection runs the base branch's remove hook inside the tree and
parks its reflection findings, as for an Orca checkout. Right before removal
it checks again that the tree's commit and branch are the ones the final
proof saw, that it gained no changes, hidden index flags or operation, and
that no process holds it: the hook may run for minutes, and a commit on a
detached head would be on no ref once the tree is gone. Git has no
check-and-remove in one step, so gc takes the tree's `HEAD.lock` in its git
directory after the last scans and before that comparison, and holds it
until the removal. From then on a commit, checkout, switch or reset in the
tree fails with git's own "cannot lock ref" error instead of moving the
head, so no commit can land on a detached head between the comparison and
the removal, and none is lost. A `HEAD.lock` another git process already
holds keeps the tree, before its hook runs. When the removal does not happen, gc deletes its lock,
and the receipt says when it could not; a run stopped by a signal before
then can leave the lock behind. The file names `jig gc` and its process, so
a person can tell it from git's own, and the next collection takes over a
lock whose run has ended. A repository that keeps
its refs in [reftable](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), git's newer reference storage, has no
`HEAD.lock` to hold: there gc keeps the tree, on a branch or detached, before
running its hook, since a tree on a branch can be detached and committed on
after the last comparison. Then it removes the tree with `git worktree remove`
without `--force`, which deletes ignored content such as dependency
directories, under a deadline of its own; a
removal cut short leaves the tree partly deleted, and the receipt says so.

A tree the kind keeps (an open pull request, unpushed commits, changes, a
process in it) is never changed. When it is on a branch, the reason names
the branch and the command that releases it while keeping every file and
commit: `git -C <tree> switch --detach`.

### Detached worktrees

A worktree on a branch is judged by the pull requests the forge lists for
that branch. A worktree whose HEAD is detached has no branch, so gc finds
its pull requests another way, and the reason it reports says which pull
requests and how they were found:

- **The drive's tree record.** When drive-pr's attach checks a pull
  request's head out detached, it records the pull request in the tree's
  git directory (`shared/driven-tree.ts`). While the head still descends
  from the commit attached and holds no other branch's work, gc judges the
  tree by that pull request.
- **The forge's pull requests for the commit.** Otherwise (no record, or a
  record the head has moved on from) gc asks the forge for the pull requests
  whose commits include the HEAD commit (`gh api
repos/<owner>/<name>/commits/<commit>/pulls`, bounded like every other
  forge call). Every one counts, a fork's included: an open one keeps the
  tree, and a commit no remote branch holds is covered only when a merged
  one's head contains it. A record left behind never names the pull request
  of work the head has moved on to. A commit the forge does not have, or
  one no pull request introduced (a direct push, a repository's first
  commit), is in no pull request; a listing that fills its page, any other refusal, or a
  record git cannot check against the head leaves the tree unverified.

The rest of the proof is the one a branched tree gets: a detached tree whose
commits no remote branch and no merged pull request's head holds is kept,
and one no pull request holds is judged as a tree without a pull request,
so one with commits of its own is kept. A tree detached at a commit of the
base branch is judged by the pull request the forge lists as bringing that
commit in, whose commits a remote branch keeps; where the forge lists none,
it is judged as a tree without a pull request.

### Run tabs

A run Jig starts in an Orca terminal tab records the tab under
`~/.local/state/jig/orca-tabs/` while it runs (`shared/orca-tabs.ts`), and
closes it when it ends: a run the dispatcher launched on every exit, and a
drive armed in a tab when it ends with nothing left for a person. A
dispatched run whose wrapper died has its tab closed by the dispatcher's
next tick with `--apply`, while nothing runs in it. A run killed before
its end that nothing closed leaves the tab and its record behind, and a
tab a drive parked for a person stays until someone closes it. The
`orca-terminals` kind joins those records to `orca terminal list --json`,
read with the machine entry's `orca.command`, and proves each tab:

- **kept** while its shell is gone or its PID was reused (the record no
  longer proves the tab is the run's), while the shell has any child process
  (a command someone typed into it), or while its last output in Orca's
  listing, or its opening when Orca has no output time, falls inside the
  guard: `orca.terminal_idle_hours`, 24 hours by default, which the machine
  can lengthen and never shorten. A process table that cannot be read counts
  every tab as busy.
- **closed** once it is idle past the guard. Collection reads Orca's listing
  and the process table again, then closes the recorded terminal with
  `orca terminal close --terminal <handle>`, never the whole tab, so a pane a
  person added beside it stays. Orca refusing the close is recorded as live.
- **forgotten** when Orca's listing no longer names it: only the record is
  deleted, and Orca is not called. A listing that leaves out a host or is cut
  short proves nothing about a tab it does not name, which stays
  `unverified`.

A tab whose shell is gone keeps its record until Orca stops listing the
tab; closing the tab by hand lets the next run delete the record. A report
(`jig gc --kind orca-terminals`) lists every recorded tab with its proof and
closes nothing. The records are read from the machine's Jig state, never
from a directory the environment names, so a tab Jig did not record is never
touched. With no records, Orca is not called.

### Worktrees Orca manages

Removing a worktree Orca manages with plain git leaves Orca's card, its
terminals and its agent records behind. When the machine entry names Orca's
command (`orca.command` in the user file's `gc` section, an absolute path:
the scheduled run is not inside an Orca terminal, so the command cannot come
from Orca's environment, and no environment names it), the inventory reads
`orca worktree list --json` for the repository and marks each checkout
`runtime: orca` or `runtime: none`. A list Orca cannot give in full fails the
inventory, so a checkout it manages never passes for a plain one.

An Orca checkout's proof reads Orca's registry (`orca worktree ps --json`)
before anything else, and again in the final proof before removal: an agent
Orca reports in any state but done (working, or waiting on a person) keeps
the worktree whatever git says, and a registry that cannot be read, is cut
short or does not list the worktree refuses collection. The registry stands
in for the session admission the opener does not hold, so an Orca checkout
that passes every other check is collected rather than reported. Collection
runs the repository's remove hook (`.config/worktree-hooks/remove`) inside
the worktree, parks its unsent reflection findings, and only then removes it
with `orca worktree rm`, never `git worktree remove`; when a step fails the
worktree stays and the receipt records the failure. The receipt of a
collected worktree names the hook it ran, or that the repository has none,
and the park.

The retiring branch could supply the hook, and it runs unattended with the
user's credentials, so collection extracts the hooks directory of the declared
base-branch commit and runs that copy, with the checkout as its working
directory; what the branch changed or added there is never run. A repository
whose base branch and checkout have no remove hook has nothing to run; a
checkout that brings a hook the base branch lacks keeps the worktree, as does
a hooks directory that `git archive` would alter through export attributes,
and so does one whose `bunfig.toml` differs from the base branch's, since that file could preload
code into the hook's Bun. A helper the hook starts from elsewhere in the
checkout is the branch's own; keep helpers beside the hook. The registry is read once more after the
hook and the park, right before `orca worktree rm`, because the hook may run
for minutes; an agent Orca started meanwhile keeps the worktree. A registry
that lists the worktree twice refuses collection. The hook's supervisor starts without the session's `JIG__` and
`JIG_OVERLAY` overrides, and its Bun ignores the checkout's environment files
and `bunfig.toml`. Parking refuses while any of those overrides is set, since
one may have moved the journal the findings were written to.

A process already in the checkout, in one of its terminals or left behind
by the hook, can still commit after the proof, and a commit on a detached
head is on no ref once the worktree goes. So collection holds an Orca
checkout to the commit and branch its final proof saw, as it holds
[a worktree an agent tool makes](#worktrees-an-agent-tool-makes): after the
registry, the launch markers and the process holders are read, it checks
that the checkout gained no changes, hidden index flags or operation, takes
its `HEAD.lock` and compares its commit and branch with the proof's. It
keeps the lock through `orca worktree rm`, which never moves the head
itself: Orca reads the checkout's status, stops its terminals and removes
it with `git worktree remove`, which deletes the lock with the worktree's
git directory; a branch it deletes afterwards is a ref of the repository,
not the worktree's head. For an Orca checkout, then, gc guarantees that a
commit made after the final proof keeps the worktree, the commit with it,
and that a commit, checkout, switch or reset tried between the last
comparison and the removal fails with git's own "cannot lock ref" error, so
none is lost. gc deletes its lock once Orca's answer settles the removal:
the worktree removed, or Orca's refusal, after which the receipt says when
the lock could not be deleted. While the answer leaves it unknown whether
the worktree is going (the cases below in which the launch guard claim
stays, among them Orca saying it is still deleting the checkout in the
background), gc leaves the lock in place, since Orca may still be removing
the worktree, and the receipt names it. The next collection of a worktree
that survived takes that lock over, since its contents name a gc run that
has ended, and holds it through its own call to Orca: the head stays held
from the first run's comparison on. Until then no commit can be made in the
worktree; when its proof finds it in use again, a person deletes the lock
by hand while no git command and no `jig gc` runs. Any other `HEAD.lock` (a git process's,
a running gc's, or one whose writer cannot be judged) keeps the worktree
before its hook runs, and so does a repository on
[reftable](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), as for
an agent tool's worktree.

Orca offers no reservation that stops a start between the registry's last
read and the removal. Jig's plugin for Orca closes that gap from inside Orca: its
`agent.launch.before` hook refuses a launch into a worktree gc holds, and
leaves a marker for every launch it lets through. gc and the plugin share
that through the [launch guard record](#the-launch-guard-record). For each
Orca checkout it collects, gc:

1. writes its admission for the worktree;
2. re-reads Orca's registry, after the hook and the park as above;
3. keeps the worktree when a launch marker for it is within the settling
   window or not older than the admission, or when the registry shows an
   agent in any state but done;
4. otherwise marks its admission submitted and removes it through Orca;
5. deletes its admission, unless `orca worktree rm` was called and gave no
   answer.

Only the removal call's answer, success or Orca's explicit refusal, the
worktree's absence from the disk and from Orca's list of the repository the
admission names, or another worktree made at its path since releases a
submitted admission. A call that timed out, exited nonzero without a refusal, printed
output gc cannot read, or answered that Orca is still deleting the checkout
in the background (it stopped waiting, or answered on accepting the
removal) may or may not have removed the worktree, so
the admission stays and the plugin's hook keeps refusing launches into it; a
gc that crashed after the mark leaves it the same way. The receipt line says
so (`details.claim: kept`, and the reason says why). The next collection
of the worktree takes the admission over from the collector that ended,
keeping its mark, proves the worktree idle again and calls `orca worktree rm`
once more; that call's answer releases it, and a refusal before the call
keeps it. A worktree whose proof finds it in use again is not collected, and
the admission stays until a person removes it after inspection; its receipt
line names the claim (`details.claim: standing`, with `details.claimNote`
saying how to inspect it) and the printed report repeats the note. A worktree that is gone from the disk and from Orca's list is
never collected again, so each run of the worktrees kind also lists, as a
line of its own with `details.claim: gone`, every admission a collector of
that repository that ended left on a path under the declared roots that is
gone from both, and collecting that line deletes the admission. Only the
repository an admission names settles it from Orca's list: two repositories
may declare a common worktree root, and one's list cannot hold the other's
worktree. While Orca's list cannot be read the admission stays. An admission
another repository's collection wrote, or one written before admissions
named their repository (version 1), is listed the same way but never
collected: its line is unverified and says why, and the admission stays
until a run of its own repository settles it or a person removes it after
inspection. A worktree made again at a claimed path is another incarnation
of it, which does not inherit the claim: each run also lists, as a line of
its own with `details.claim: superseded` whose resource is the admission's
file, every admission a collector that ended left on a path under the
declared roots where a worktree born later than the one it claimed now
stands, and collecting that line deletes the admission after reading the
incarnation once more. The disk is that proof, so any repository whose
roots hold the path settles it. A live collector's admission is never
touched.

The launch markers are read once right after the admission, before the hook
runs, and again after the registry's last read. A worktree the guard keeps is
`refused`, and the reason names the launch. gc trusts the guard only while
the plugin's heartbeat is fresh. Without one (the plugin is not installed,
Orca is closed, or its worker stopped) collection runs as it would without
the plugin. Every Orca checkout's receipt line says which held when it was
proved and collected: `details.guard` is `guarded` or `unguarded`, the
reason ends with why, and the report prints it beside the runtime, as in
`(orca, unguarded)`. Each collection of an Orca checkout first deletes the
launch markers older than a day.

#### The launch guard record

The plugin's hook must answer within two seconds without awaiting a call to
Orca, and the plugin is plain Node with no dependencies, so it reads and
writes these files directly. This section is the contract between the two;
`shared/orca-guard.ts` is gc's side of it.

**Directory.** `<home>/.local/state/jig/orca-guard/`, the same Jig state root
every other machine record uses. Orca's plugin worker receives `PATH`,
`HOME`, the locale, `TZ` and the temporary-directory variables, and no
`XDG_*` or `JIG_*` variable, so the default depends on the home directory
alone:

| Platform | Directory                                                    | How a plugin computes it                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux    | `$HOME/.local/state/jig/orca-guard/`                         | `path.join(os.homedir(), ".local", "state", "jig", "orca-guard")`; `os.homedir()` is `$HOME`                                                                                                                                                   |
| macOS    | `$HOME/.local/state/jig/orca-guard/` (not under `~/Library`) | the same; `os.homedir()` is `$HOME`                                                                                                                                                                                                            |
| Windows  | `%USERPROFILE%\.local\state\jig\orca-guard\`                 | the same; Node's `os.homedir()` reads `USERPROFILE` and, in a worker without it, asks Windows for the profile directory. Do not use `HOME`: a Unix-style shell on Windows may set it to another directory, and Jig does not read it on Windows |

Jig honours no `XDG_STATE_HOME` here, so neither may the plugin. A plugin
setting that overrides the directory must name the one Jig uses.

**Files.** One file per entry. A writer writes the whole JSON to a temporary
file in the same directory, named so it does not end in `.json` (Jig's start
with `.` and end in `.tmp`), then renames it into place; nobody edits a file
in place or reads, changes and rewrites a shared one. gc publishes an
admission with a link instead of a rename, so a second collector's link fails
rather than replacing it. It takes over an admission whose holder is dead,
or deletes one whose worktree is gone, only while it holds a file lock
beside it (`admissions/reclaim.<digest>.lock`, the lock `shared/file-lock.ts`
publishes whole and hands from a dead holder to one reclaimer at a time), after
reading the admission again, and takes it over by a rename, so the file is
never absent meanwhile. It marks its own admission submitted by renaming the
marked copy over it.

| File                    | Written by                                                             | Kind                   |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------- |
| `admissions/<key>.json` | gc, while it collects the worktree                                     | `orca-guard-admission` |
| `launches/<key>.json`   | the plugin, for each launch it lets through, before the launch goes on | `orca-guard-launch`    |
| `heartbeat.json`        | the plugin, about every 60 s while its worker runs                     | `orca-guard-heartbeat` |

**Key.** `<key>` is the lowercase hexadecimal SHA-256 of the worktree's path,
as UTF-8 bytes, exactly as Orca reports it (its `path` in
`orca worktree list --json`): no resolved links, no changed separators, no
trailing slash added or removed.
In Node, `crypto.createHash("sha256").update(path).digest("hex")`.

**Format.** Each file is one JSON object carrying the
[record envelope](../RECORDS.md#the-registry-and-the-envelope): `kind`, `v`
(the schema version: `2` for an admission, `1` for a launch marker and the
heartbeat), `key`, `writer` (an object with at
least `host`, a non-empty string, and optionally `pid`, `bootId`, `start` and
`login`) and `at` (a UTC time as `Date.prototype.toISOString` writes
it), then the kind's own fields. A writer may add no other envelope field
(`generation` is unused here). gc writes the JSON on one line followed by a
newline, with every `<` and `>` inside a string escaped as `\u003c` and
`\u003e`; a plugin may write any valid JSON, and `JSON.parse` reads both.

An admission. Its `at` is when gc wrote it, `repository` the path, links
resolved, of the repository whose collection wrote it, `incarnation` what
stood at the worktree's path when gc wrote it (its inode and its birth time
in nanoseconds, joined by `:`; absent when gc could not read it), `holder`
the collecting process's identity (`shared/liveness.ts`), and `submitted`,
present once gc is about to call `orca worktree rm` under it, when it did so,
in the same form as `at`. Orca can give a worktree made again at a path the
id the old one had, so the id cannot tell the two apart. gc takes the
worktree at the path as made again only when its birth time is later than
the one `incarnation` records: an inode number can change on a remount and
a birth time can be set back, so neither a changed inode nor an earlier
birth time counts, and without both birth times nothing does. Version 1,
which earlier releases wrote, has no `repository` and no `incarnation`; gc
still reads it.

```json
{
  "kind": "orca-guard-admission",
  "v": 2,
  "key": "481ad110b5d9b30b0c46972739bb0e3d2aeb2c05c5dd3804e8a124048162f2ca",
  "writer": {
    "host": "laptop",
    "bootId": "6c2e8f4a-1b3d-4f5e-9a7c-2d4b6e8f0a1c",
    "pid": 48213,
    "start": "Thu Nov  5 03:00:01 2026"
  },
  "at": "2026-11-05T03:00:12.345Z",
  "path": "/home/ada/orca/workspaces/app/topic",
  "repository": "/home/ada/dev/app",
  "incarnation": "40894477:1793847601123456789",
  "holder": {
    "hostId": "3f1c9a0e5b7d4e2a8c6f1b0d9e7a5c3b",
    "host": "laptop",
    "bootId": "6c2e8f4a-1b3d-4f5e-9a7c-2d4b6e8f0a1c",
    "pid": 48213,
    "start": "Thu Nov  5 03:00:01 2026"
  },
  "submitted": "2026-11-05T03:04:40.118Z"
}
```

A launch marker. Its `at` is when the plugin let the launch through,
`workspaceId` is Orca's id of the workspace, and `agent` the agent it
launches:

```json
{
  "kind": "orca-guard-launch",
  "v": 1,
  "key": "481ad110b5d9b30b0c46972739bb0e3d2aeb2c05c5dd3804e8a124048162f2ca",
  "writer": { "host": "laptop", "pid": 51022 },
  "at": "2026-11-05T03:00:13.002Z",
  "path": "/home/ada/orca/workspaces/app/topic",
  "workspaceId": "repo-1::/home/ada/orca/workspaces/app/topic",
  "agent": "claude"
}
```

The heartbeat. Its `key` is always `heartbeat`, `pid` is the worker's
process id and `pluginVersion` the plugin's version:

```json
{
  "kind": "orca-guard-heartbeat",
  "v": 1,
  "key": "heartbeat",
  "writer": { "host": "laptop", "pid": 51022 },
  "at": "2026-11-05T03:00:00.000Z",
  "pid": 51022,
  "pluginVersion": "0.4.0"
}
```

**Order.** The hook writes its launch marker first, then reads the
admission: when an admission stands, it refuses the launch. gc writes its
admission first, then reads the launch marker. Each side writes before it
reads, so a launch and a collection that overlap are seen by at least one of
them. A refused launch's marker keeps the worktree for this collection,
which costs a later run and loses nothing.

**Reading.** A heartbeat that is missing, does not parse, lacks its `pid` or
`pluginVersion`, or has a `kind`, `v` or envelope a reader does not know
counts as absent. An admission or a
launch marker in that state (a launch marker also when its `path`,
`workspaceId` or `agent` is missing) counts as present: the plugin refuses the launch,
and gc keeps the worktree and leaves the file for a person to inspect. So
does an admission whose `submitted` is present but not a time, and a version
2 admission without its `repository` or whose `incarnation` is present but
not a non-empty string. A reader
ignores a kind's field it does not know, so a field added to a kind keeps
its version: the plugin's hook, which refuses a launch into any worktree
with an admission present, reads an admission with `submitted` as it reads
one without. The admission's `repository` and `incarnation` changed its
version instead, because a reader that ignored them would release a claim
from a list or a disk that cannot show its worktree gone: a release of gc
that reads only version 1 keeps a version 2 admission as one it cannot read,
for a person to inspect, and never releases it. A submitted admission
excludes launches whatever its holder's state: a reader that ever treats a
dead holder's admission as abandoned may do so only for one without
`submitted`, except that gc releases one whose worktree a later one has
superseded at its path, since what it claimed is then gone.

**Constants.**

| Constant            | Value | Meaning                                                                                                                                                                                             |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat freshness | 180 s | The heartbeat is fresh while its `at` is within 180 s of now; gc collects as guarded only then                                                                                                      |
| Settling window     | 120 s | A launch marker keeps its worktree while its `at` is within 120 s of now, and always when its `at` is not before the admission's `at`                                                               |
| Marker retention    | 1 day | Each collection of an Orca checkout first deletes launch markers whose `at` (or, when one does not read, whose modification time) is more than a day old, and the plugin's temporary files that old |

An admission is deleted by the collector that wrote it once the worktree is
removed or kept, unless it is submitted and the removal call gave no answer.
One left by a collector that ended stays until a later collection settles
it, judging its holder dead by identity, never by age: the next collection
of that worktree takes it over (dropping its `submitted` when it was written
for another incarnation, whose removal is then settled), or a run of the
repository it names finds the worktree gone from Orca's list and from the
disk and deletes it, or a run of any repository whose roots cover the path
finds a worktree made again there, born later, and deletes it. Until then the hook refuses launches
into that worktree.

Reports and collections use the same receipt schema and human formatter.
`would-collect`, `collected`, `refused`, `finding`, `unverified` and `failed`
are distinct outcomes. Exit status is 0 for a completed run, including no
eligible resources, 1 for an inventory or collection failure, and 2 for bad
arguments or configuration. Receipts live under
`~/.local/state/jig/gc/<date>/<run-id>.json`; the run id includes start time,
process id and a random identifier so concurrent runs cannot overwrite one
another. Unfinished receipts preserve their action evidence even past the
retention period. A missing process identity or forge answer keeps the resource. An interrupted
run retains `completed: false`; a resource whose removal started retains its
proof with an unverified completion until the result is recorded.

A run whose configuration fails before it plans any kind (a report,
`--collect` or `--scheduled`) collects nothing, prints the reason on standard
error and still writes a receipt, with no kinds or resources and a `failure`
naming why: `code` is `configuration` for a gc setting the run refuses (exit 2) and `unreadable` for a configuration file it cannot read (exit 1), and
`reason` is the message printed. Nothing was left in flight, so the receipt
records `completed: true` and expires with the rest. A receipt without
`failure` planned its kinds.

The installed job runs daily, reports by default, and collects on the
configured weekday or under configured disk pressure. It uses launchd on
macOS, a systemd user timer on Linux where available, and cron otherwise.
The job records its environment and the path of Bun, but not the plugin
copy's, which changes with each release. It runs a launcher that install
copies, with the trusted startup file, to `~/.local/state/jig/gc/launcher/`
(the `jig` command runs its own copy of the same launcher).
At each run the launcher asks the agent tool (`claude plugin list --json`, or
`codex plugin list --json`, by the absolute path found at install) for the
installed copy of the plugin and runs that copy's collector, so a plugin
update reaches the job without a new install. A copy inside a git checkout is
refused, as at install, and so is an agent tool found inside one, by its path
or by any directory or symbolic link its resolution passes through. Install itself fails when the launcher could
not find the plugin it would run. Removing a repository while others remain
changes only the machine entry and leaves the job, its launcher and the agent
tools it recorded as they are, so it never needs the plugin to be found. A run that finds no installed copy later fails
and says so in the scheduler's error output. An agent tool that does not answer within 30 seconds or prints more than 4 MiB gets `SIGKILL` with its process group, and its lookup fails: the launcher then asks the other agent tool it recorded, and the run fails, naming each failed lookup, only when none names an installed copy. A stop from the scheduler during the lookup ends the agent tool too and asks no further one. A run is bounded: past the heavy-run lock's wait (`LOCK_TIMEOUT`, an hour unless set) and two hours more, or when the scheduler stops the launcher, the collector's process group gets `SIGTERM`, then `SIGKILL` 30 seconds later, and the run fails. The launcher signals only the process groups it started: a descendant that starts its own session leaves the group, is not stopped, and can no longer hold the run open. Install records `LOCK_TIMEOUT` in the job when it is set, and refuses a value the lock would not accept. The job's environment carries
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` when set, so it asks the same registry
the install did. `jig upgrade` replaces the launcher with the new
release's and rewrites the job in that release's form, keeping what the job
records; run `jig install gc --repo <repository> --yes` again after moving
Bun or an agent tool. `jig doctor gc` says when either is needed. A failed install puts back the previous job's files, launcher and activation. Collecting
runs hold
the same heavy-run lock as local gates, exclusively: a collection waits until
no heavy run holds any of the lock's slots, holds them all while it
collects, and new heavy runs wait behind it. A heavy run that hangs therefore
holds back every new run on the machine until the collection's lock wait
(`LOCK_TIMEOUT`) runs out; set a shorter one for the job where that is too long. The design's later container, branch
and process kinds wait for the first-stage rollout to run in a working
repository. Registered test scopes have conditional collection; other scratch remains report-only.

This implements the resource lifecycle practice of
[M12](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md).
