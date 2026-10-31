# Resource collection

Agent sessions leave scratch directories and tool state on a developer
machine. A collector needs evidence that their owners have finished before it
removes anything. `jig gc` reports that evidence, refuses uncertainty, checks
again before collection, and leaves a receipt for every run.

Run from an installed plugin copy with trusted Bun startup. Replace
`<plugin>` with its absolute installed path. In the examples, `jig` means
`bun --no-env-file --config=<plugin>/gc/bunfig.toml <plugin>/jig.ts`; it can
be a shell alias for that full command. The trusted configuration prevents a
checkout's Bun preloads and environment files from running before collection.


```sh
jig gc
jig gc --repo <repository> --kind scratch --json
jig gc --collect
jig gc receipts
jig gc install --repo <repository>
```

The install command prints a preview. Repeat with `--yes` to confirm the
bounds and write the machine entry and daily scheduler job. `install
--uninstall` removes this repository's entry; the job stays while any
repository or machine kind remains. `install --uninstall --machine` removes
every entry and the shared job. Each operation previews before `--yes`.
A checkout can run reports; scheduling requires an installed copy that a
worktree reaper cannot remove.

The repository declares kinds in `.config/jig.yaml`. The machine file
controls the schedule, retention and longer idle guards. Collecting runs
fetch the declaration from the install-recorded base branch and remote URL,
refusing when a URL rewrite rule redirects that URL; only the intersection
with confirmed install bounds is authorized. Git hooks and the file-system
monitor are disabled for these calls; transport and credential settings the
user configured (an SSH command, a credential helper) apply as they do to the
user's own fetches. See
[configuration](../CONFIGURATION.md#gc).

| Kind | Behavior |
|------|----------|
| `tool-state` | Runs drive-pr's existing state reaper in report mode for each configured clone. Receipts retain its full per-family proof. Collection remains disabled until state creators hold shared admission across every state use; the legacy reaper lock excludes only other reapers. |
| `scratch` | Inventories only declared directory prefixes. Owner records include captured process creation identities; a live owner anywhere in the subtree keeps the root. Where the identity cannot be captured (no readable process table), the record says so and the root is kept as unverified. Missing ownership is a finding. Collection remains disabled until fixture registration proves all holders gone. |
| `worktrees` | Reports Git changes, hidden index flags, operations, pull request state, remote commit coverage, process holders and idleness. The primary checkout and paths outside declared roots are excluded. Ignored local content needs preservation evidence. A worktree [Orca](https://www.onorca.dev) manages is marked `runtime: orca` and collected through Orca ([below](#worktrees-orca-manages)); any other eligible worktree remains report-only until the opener shares session admission. |
| `receipts` | Machine kind; removes receipts past retention while preserving the latest completed report for each repository and kind. Unfinished receipts and runs whose inventory failed never take that place. |

Scratch creators use `shared/gc-lock.ts` to hold shared admission while
creating a scope and writing its owner record. Collectors take exclusive
admission across the final proof and removal. An abandoned admission token
blocks collection and needs inspection; it is never stolen on age.
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

The installed job runs daily, reports by default, and collects on the
configured weekday or under configured disk pressure. It uses launchd on
macOS, a systemd user timer on Linux where available, and cron otherwise.
The job records its environment and the path of Bun, but not the plugin
copy's, which changes with each release. It runs a launcher that install
copies, with the trusted startup file, to `~/.local/state/jig/gc/launcher/`.
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
the install did. Run `jig gc install --repo <repository> --yes`
again after moving Bun or an agent tool, or to replace the launcher. A failed install puts back the previous job's files, launcher and activation. Collecting
runs hold
the same heavy-run lock as local gates. The design's later container, branch
and process kinds wait for the first-stage rollout to run in a working
repository; scratch remains report-only until the process stage.

This implements the resource lifecycle practice of
[M12](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md).
