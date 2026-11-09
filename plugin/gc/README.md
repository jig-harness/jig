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
with confirmed install bounds is authorized. Git hooks and the file-system
monitor are disabled for these calls; transport and credential settings the
user configured (an SSH command, a credential helper) apply as they do to the
user's own fetches. See
[configuration](../CONFIGURATION.md#gc).

| Kind         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-state` | Runs drive-pr's state reaper in report mode for each configured clone: the files a clone keeps beside the drive's database that the reaper would retire. Receipts retain its full per-family proof. Collection remains disabled until state creators hold shared admission across every state use; the reaper's lock excludes only other reapers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `scratch`    | Inventories only declared directory prefixes. Owner records include captured process creation identities; a live owner anywhere in the subtree keeps the root. Where the identity cannot be captured (no readable process table), the record says so and the root is kept as unverified. Missing ownership is a finding. Collection remains disabled until fixture registration proves all holders gone.                                                                                                                                                                                                                                                                                                                                                 |
| `worktrees`  | Reports Git changes, hidden index flags, operations, pull request state, remote commit coverage, process holders and idleness. The primary checkout and paths outside declared roots are excluded. Ignored local content needs preservation evidence, except a detected package manager's dependency directory (`node_modules`, wherever it sits in the tree), which is rebuildable from the root `package.json` and tracked lockfile and never vetoes on its own; the receipt lists the paths set aside this way. A worktree [Orca](https://www.onorca.dev) manages is marked `runtime: orca` and collected through Orca ([below](#worktrees-orca-manages)); any other eligible worktree remains report-only until the opener shares session admission. |
| `receipts`   | Machine kind; removes receipts past retention while preserving the latest completed report for each repository and kind. Unfinished receipts and runs whose inventory failed never take that place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Scratch creators use `shared/gc-lock.ts` to hold shared admission while
creating a scope and writing its owner record. Collectors take exclusive
admission across the final proof and removal. Each admission token holds its
creator's [process identity](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(`shared/liveness.ts`). An abandoned admission token blocks collection and
needs inspection; it is never stolen on age, and the refusal names its
creator and why that creator counts as gone.
Worktree openers have not adopted that protocol, so clean or merged worktrees
are reported only, except those a workspace runtime manages.

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

Orca offers no reservation that stops a start between that last read and the
removal. Jig's plugin for Orca closes that gap from inside Orca: its
`agent.launch.before` hook refuses a launch into a worktree gc holds, and
leaves a marker for every launch it lets through. gc and the plugin share
that through the [launch guard record](#the-launch-guard-record). For each
Orca checkout it collects, gc:

1. writes its admission for the worktree;
2. re-reads Orca's registry, after the hook and the park as above;
3. keeps the worktree when a launch marker for it is within the settling
   window or not older than the admission, or when the registry shows an
   agent in any state but done;
4. otherwise removes it through Orca;
5. deletes its admission either way.

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

| Platform | Directory | How a plugin computes it |
| -------- | --------- | ------------------------ |
| Linux | `$HOME/.local/state/jig/orca-guard/` | `path.join(os.homedir(), ".local", "state", "jig", "orca-guard")`; `os.homedir()` is `$HOME` |
| macOS | `$HOME/.local/state/jig/orca-guard/` (not under `~/Library`) | the same; `os.homedir()` is `$HOME` |
| Windows | `%USERPROFILE%\.local\state\jig\orca-guard\` | the same; Node's `os.homedir()` reads `USERPROFILE` and, in a worker without it, asks Windows for the profile directory. Do not use `HOME`: a Unix-style shell on Windows may set it to another directory, and Jig does not read it on Windows |

Jig honours no `XDG_STATE_HOME` here, so neither may the plugin. A plugin
setting that overrides the directory must name the one Jig uses.

**Files.** One file per entry. A writer writes the whole JSON to a temporary
file in the same directory, named so it does not end in `.json` (Jig's start
with `.` and end in `.tmp`), then renames it into place; nobody edits a file
in place or reads, changes and rewrites a shared one. gc publishes an
admission with a link instead of a rename, so a second collector's link fails
rather than replacing it. It replaces an admission whose holder is dead only
while it holds a lock file created exclusively beside it
(`admissions/.<key>.json.reclaim`), after reading the admission again.

| File | Written by | Kind |
| ---- | ---------- | ---- |
| `admissions/<key>.json` | gc, while it collects the worktree | `orca-guard-admission` |
| `launches/<key>.json` | the plugin, for each launch it lets through, before the launch goes on | `orca-guard-launch` |
| `heartbeat.json` | the plugin, about every 60 s while its worker runs | `orca-guard-heartbeat` |

**Key.** `<key>` is the lowercase hexadecimal SHA-256 of the worktree's path,
as UTF-8 bytes, exactly as Orca reports it (its `path` in
`orca worktree list --json`): no resolved links, no changed separators, no
trailing slash added or removed.
In Node, `crypto.createHash("sha256").update(path).digest("hex")`.

**Format.** Each file is one JSON object carrying the
[record envelope](../RECORDS.md#the-registry-and-the-envelope): `kind`, `v`
(the schema version, `1` for every kind), `key`, `writer` (an object with at
least `host`, a non-empty string, and optionally `pid`, `bootId`, `start` and
`login`) and `at` (a UTC time as `Date.prototype.toISOString` writes
it), then the kind's own fields. A writer may add no other envelope field
(`generation` is unused here). gc writes the JSON on one line followed by a
newline, with every `<` and `>` inside a string escaped as `\u003c` and
`\u003e`; a plugin may write any valid JSON, and `JSON.parse` reads both.

An admission. Its `at` is when gc wrote it, and `holder` is the collecting
process's identity (`shared/liveness.ts`):

```json
{"kind":"orca-guard-admission","v":1,"key":"481ad110b5d9b30b0c46972739bb0e3d2aeb2c05c5dd3804e8a124048162f2ca","writer":{"host":"laptop","bootId":"6c2e8f4a-1b3d-4f5e-9a7c-2d4b6e8f0a1c","pid":48213,"start":"Thu Nov  5 03:00:01 2026"},"at":"2026-11-05T03:00:12.345Z","path":"/home/ada/orca/workspaces/app/topic","holder":{"hostId":"3f1c9a0e5b7d4e2a8c6f1b0d9e7a5c3b","host":"laptop","bootId":"6c2e8f4a-1b3d-4f5e-9a7c-2d4b6e8f0a1c","pid":48213,"start":"Thu Nov  5 03:00:01 2026"}}
```

A launch marker. Its `at` is when the plugin let the launch through,
`workspaceId` is Orca's id of the workspace, and `agent` the agent it
launches:

```json
{"kind":"orca-guard-launch","v":1,"key":"481ad110b5d9b30b0c46972739bb0e3d2aeb2c05c5dd3804e8a124048162f2ca","writer":{"host":"laptop","pid":51022},"at":"2026-11-05T03:00:13.002Z","path":"/home/ada/orca/workspaces/app/topic","workspaceId":"repo-1::/home/ada/orca/workspaces/app/topic","agent":"claude"}
```

The heartbeat. Its `key` is always `heartbeat`, `pid` is the worker's
process id and `pluginVersion` the plugin's version:

```json
{"kind":"orca-guard-heartbeat","v":1,"key":"heartbeat","writer":{"host":"laptop","pid":51022},"at":"2026-11-05T03:00:00.000Z","pid":51022,"pluginVersion":"0.4.0"}
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
and gc keeps the worktree and leaves the file for a person to inspect.

**Constants.**

| Constant | Value | Meaning |
| -------- | ----- | ------- |
| Heartbeat freshness | 180 s | The heartbeat is fresh while its `at` is within 180 s of now; gc collects as guarded only then |
| Settling window | 120 s | A launch marker keeps its worktree while its `at` is within 120 s of now, and always when its `at` is not before the admission's `at` |
| Marker retention | 1 day | Each collection of an Orca checkout first deletes launch markers whose `at` (or, when one does not read, whose modification time) is more than a day old, and the plugin's temporary files that old |

An admission is deleted by the collector that wrote it once the worktree is
removed or kept. One left by a collector that died stays until the next
collection of that worktree, which replaces it when its holder is judged dead
by identity, never by age; until then the hook refuses launches into that
worktree.

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
naming why: `code` is `configuration` for a gc setting the run refuses (exit
2) and `unreadable` for a configuration file it cannot read (exit 1), and
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
repository; scratch remains report-only until the process stage.

This implements the resource lifecycle practice of
[M12](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md).
