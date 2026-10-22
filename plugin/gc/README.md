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
| `worktrees` | Reports Git changes, hidden index flags, operations, pull request state, remote commit coverage, process holders and idleness. The primary checkout and paths outside declared roots are excluded. Ignored local content needs preservation evidence. Eligible worktrees remain report-only until the opener shares session admission. |
| `receipts` | Machine kind; removes receipts past retention while preserving the latest completed report for each repository and kind. Unfinished receipts and runs whose inventory failed never take that place. |

Scratch creators use `shared/gc-lock.ts` to hold shared admission while
creating a scope and writing its owner record. Collectors take exclusive
admission across the final proof and removal. An abandoned admission token
blocks collection and needs inspection; it is never stolen on age.
Worktree openers have not adopted that protocol, so clean or merged worktrees
are reported only.

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
The job records its executable paths and environment, the installed plugin
copy's path among them. That path changes with each plugin release, so run
`jig gc install --repo <repository> --yes` again after updating the plugin.
A failed install puts back the previous job's files and activation. Collecting
runs hold
the same heavy-run lock as local gates. The design's later container, branch
and process kinds wait for the first-stage rollout to run in a working
repository; scratch remains report-only until the process stage.

This implements the resource lifecycle practice of
[M12](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/README.md).
