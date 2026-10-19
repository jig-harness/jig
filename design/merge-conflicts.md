# Merge conflicts, measured: design

**What problem this solves.** When several people or agents work on one
repository in parallel, each merge can put the other open pull requests in
conflict. Every conflict costs a resolution (often an agent's session) and
another full [CI](../GLOSSARY.md) run, and nobody can say how many there
were, which files caused them or why. A repository fixes the one it notices
(Jig moved its changelog to [change notes](../changes/README.md) for this
reason, [ADR-0004](../docs/adr/ADR-0004-change-notes-released-after-the-merge.md))
and lives with the rest. With this built, a repository can list where its
merges conflict, sorted by how often, with the cause of each conflict and the
change that removes it, and can see whether a fix worked.

This is the design of [plan.md](plan.md) item 22. The replay, its causes and
the report (step 1 of the build order) are built: `history.ts` in the
[`resolve-conflicts` skill](../plugin/skills/resolve-conflicts/SKILL.md#where-past-merges-conflicted-the-history-report).
The live record, the practice and the learning loop are not. The skill
also maps each conflict and records a decision and a reason for each path;
that record is the richest source this design uses, and today it is
overwritten by the next operation.

## What a replay of Jig's own history shows

On 2026-10-18, every merge commit in a clone of Jig was merged again with
`git merge-tree`, which merges two commits without touching a working tree
and lists the paths that conflict. Most of the merges in Jig's history
bring `main` into a feature branch, and most of those conflicted. The paths,
from most often:

- `CHANGELOG.md`: every pull request added its entry at the same place. None
  since change notes replaced those edits.
- Both plugin manifests: the release step changed the version line, and a
  branch that added a skill changed the description on the next line, which
  named every skill. Git reports changes to adjacent lines as one conflict.
- The audit sheet's tests: they listed, and counted, every criterion Jig had
  added, so each pull request that added a criterion changed the same count.
- `ROADMAP.md`: two branches changing the same item, one finishing a bullet
  while the other rewrote it, and the restructure that split the plan from
  the roadmap.
- The glossary, its allowlist, and the list of gate steps: lists to which
  every pull request adds at the same place.

All of them but the roadmap have one shape in common: a fact that grows with
every change (a count, a list, a version) kept in one place that every
change edits. The roadmap's are the other kind, two pieces of work changing
the same thing. This design tells the two apart.

The replay has limits the design keeps: it sees only merge commits that still
exist, so a conflict resolved during a rebase, a cherry-pick or a revert, or
on a branch deleted after a squash merge, leaves nothing to replay; a clone sees the merges its refs
reach, and a workspace tool's own refs on one machine can reach far more
than a fresh clone; it counts a conflict once for each merge that meets it
again; and a merge that git combines cleanly but that breaks the build is
not a conflict to it.

## How it works

### Sources, one record

Each source yields the same record per conflicted path: the operation, the
path, the kind of file, the conflicting regions with a cause for each
(below), and the decision and reason when they are known.

1. **Replay** (`resolve-conflicts/scripts/history.ts`): for every merge commit
   reachable from the repository's refs, and from the forge's pull-request
   heads when they have been fetched, run
   `git merge-tree --write-tree` on its two parents, with
   `merge.conflictStyle=diff3` so each region carries its merge base, and
   read the conflicted regions from the tree it writes. Git writes that
   tree's objects, so the replay points `GIT_OBJECT_DIRECTORY` at a
   temporary directory (with the repository's own objects as an alternate)
   and removes it afterwards: no ref, index, working tree or object of the
   repository changes. It needs no setup and nothing installed
   in the past, so a repository can measure its history on the day it
   adopts Jig. Today's attributes and merge drivers are kept out of the
   past merges: the working tree's and the index's attributes are read
   from the empty tree, the system's and a person's attributes files are
   not read, and every configured driver is replaced by `false`. Git still
   reads `.git/info/attributes`, so a marker size or a built-in driver set
   there still applies, but no driver command runs. It never fetches: it
   needs git 2.43 or later, the first whose `merge-tree` reads
   `GIT_ATTR_SOURCE` reliably, refuses a partial clone
   below git 2.45, which cannot be kept from fetching, and exits with a
   message otherwise. In a shallow clone a merge whose merge base the
   boundary hides would replay as if the two sides had added every file, so
   it is skipped and the report says its results are partial.
2. **Resolution sections**: `resolve-conflicts` writes a
   `Conflicts resolved:` section into the merge commit's message, one line
   per path with its decision and reason. The replay reads the section of
   each merge it replays, so a path gets its decision and reason without any
   new store.
3. **Live record**: when `resolve-conflicts` concludes an operation, it
   appends one event per path to a JSON Lines file in git's common directory
   (`$(git rev-parse --git-common-dir)/jig/conflict-events.jsonl`), which all
   worktrees of the clone share and nothing commits. It covers what the replay
   cannot see: each stop of a rebase, a cherry-pick and a revert, the time
   from the map to the conclusion, and whether `drive-pr` started the
   resolution in its conflict-resolve round. The file reaches the report only
   in the clone that runs it: an operation resolved in another clone, or in a
   workspace since discarded, leaves no event there, and the report says that
   its live events are this clone's. A repository that runs
   [M11](../modules/M11-process-observability/README.md)'s event pipeline
   sends the same events there through its own emitter.

The event is M11's new `merge_conflict` type, with `operation`, `path` and
`cause` required, and the decision, reason, regions, time and source
optional. It also carries the commit the operation concluded with and, when
the branch has one, its pull request. The kind of each operation (merge,
rebase, cherry-pick or revert) and its two sides are fields too, so the report can separate a branch catching up
with its base from two branches meeting.

One conflict is one record, however many sources see it. A record is
identified by its operation's concluding commit and its path. The replay
makes the record for every merge it can replay; the resolution section of
the same merge adds its decision and reason to that record; a live event
for a merge adds its time and the `drive-pr` mark to the replayed record of
the merge it concluded with, and never counts a second time. Live events
for a rebase, a cherry-pick or a revert, which the replay cannot see, are
the only record of those operations and count on their own.

### Causes

A lockfile or generated file is `derived`, whatever git reports for it. Any
other path that git reports as conflicting without text regions has one
cause, `structural`, for the path as a whole. Every other conflicted path gets a
cause for each conflicting region, in this order; the first that matches
wins. Each region has three sides: the [merge base](../GLOSSARY.md), ours
and theirs. A cause is derived from the region and, where its row says so,
from the three versions of the region's file, which the replay already
holds; a cause whose evidence those do not settle does not match, so a
region falls to `overlap` rather than to a guess. A path has the causes of
its regions, and a path or a merge counts as mechanical only when none of
its paths is `structural` and every region has a cause other than
`overlap`, so one `overlap` region beside an `append` keeps the merge from
being reported as mechanical.

| Cause | How it is recognised | The change that removes it |
| --- | --- | --- |
| `derived` | the path is a lockfile or a generated file (the classification `resolve-conflicts` already makes) | regenerate it; keep it out of pull requests if a step after the merge can write it |
| `structural` | a path-level cause: git reports the path's conflict without text regions (a binary file, a modify/delete, a rename, a file/directory or a mode conflict) | none from the regions; the report lists it with git's own kind of conflict, and resolving it stays a decision |
| `echo` | the two sides of the region are identical, or one side's edit from the base is already in the other side: every line it added is there, every line it removed is not, and the lines the two share stand in the same order (a branch built on another that was squash-merged underneath it); the contained edit adds at least one line, since an edit that only removes lines is in any rewrite of them; anything less, including sides that only nearly match, is not `echo` | keep the side that contains the other; rebuild a branch on its base once the branch it was built on merges |
| `version` | the sides differ only in the release version of an artifact the repository's release step writes (the files `changelog.version` names, on the lines that hold the version), or in a date stamp (`last_updated`); a dependency, runtime or protocol version that differs is a choice between the sides, and leaves the region `overlap` | the version moves after the merge (ADR-0004's release step); a date comes from git instead of the file |
| `sequence` | both sides add an entry with the same next ordinal (a migration number) | identifiers that cannot collide (a timestamp), or one step that renumbers the entry everywhere it is named |
| `tally` | with every number replaced by one placeholder, the two sides are equal, and, read from the three versions of the file, each side's number moved from the base by the net number of lines that side added to the file (a count of a list with one entry per line), or by the net number of lines it added above a stored line number; a number that differs any other way (a setting, a limit), or one that counts something outside the file, leaves the region `overlap` | derive the number where it is used ([M2](../modules/M2-generated-artifact-freshness/README.md#which-numbers-in-prose-may-stay)); a register that stores line numbers keys its entries by name instead |
| `append` | the base side of the region is empty: both sides added lines at the same place; a file both sides added has no base, and its regions are not `append` | one file per entry (as change notes are), or a sorted list with one entry per line |
| `packed-list` | the region is one line in every side, and each side adds items to a list in it, changing or removing none | one item per line, or stop listing what another file already lists |
| `adjacent` | the lines each side changed do not overlap, but touch | split what changes for different reasons onto lines or files of its own |
| `overlap` | none of the above: both sides changed the same lines | two pieces of work changed the same thing; plan them apart ([M12](../modules/M12-parallel-agent-ergonomics/README.md)) or land one first |

`overlap` and `structural` are the causes no change to the files can remove. Every other
cause is a fact about where the repository keeps something, and the report
names its remedy.

A union merge driver (git's `merge=union`, which keeps both sides' lines) is
not offered as a remedy: it acts only in merges run on a machine, GitHub
still reports the pull request as conflicting, and the lines land without
regard to the file's structure (ADR-0004, Alternatives considered).

The causes are recognised from the regions' shape, so the report says how
sure it is. Building the replay includes hand-checking a sample of regions
for each cause, and the report states the result for each, so a cause that
is often wrong is named as such. The result is kept beside the skill
(`references/cause-accuracy.json`), and the report prints it. On Jig's
history, every sampled region was right except some `overlap` ones: counts
of something outside the file, and release versions in a region that held
another change too, which the rules leave to `overlap` because the region
does not settle them. An `append` in source code can be the same
fix written twice, so the report names the remedy for an `append` in code as
a question, not an instruction.

### The report

`history.ts` prints, for a range of time (the last 30 days by default):

- how many merges conflicted, of how many;
- the paths that conflicted, most often first, each with its causes and the
  remedy for the most frequent one;
- the [conflict hotspots](../GLOSSARY.md): the paths that conflicted in at
  least 3 merges in the range (set in configuration), the ones worth a
  change;
- per week, conflicted merges by cause, so the effect of a fix shows as a
  cause that stops.

It prints to the terminal, or as JSON with a versioned schema
(`merge-conflicts/v1`) for the audit and for M11's metric. It reads git only,
and leaves the repository as it found it (the replay's objects go to a
temporary directory).

### From measure to change

- **M12** states the practice: a repository that runs work in parallel
  measures where its merges conflict, and a hotspot is either removed at its
  cause or kept by a recorded decision. A new audit criterion scores it, and
  `jig:audit` runs the replay as read-only evidence.
- **M11** registers the metric, the share of merged pull requests that met
  at least one conflict before they merged, in its metric registry. Its
  denominator is the scoreboard's own cohort of merged pull requests (the
  forge's list, over the scoreboard's window), and each pull request in it
  is one of these:
  - *conflicted*, when a conflicted record (replayed, or a live event) names
    it, however many times;
  - *observed clean*, when the replay reached its head and found no
    conflict, and the forge records no force-push of its branch (a
    force-push can hide a rebase, and a rebase's conflicts leave nothing to
    replay); the live record holds only conflicts that happened, so its
    silence is never evidence of a clean pull request, and a cherry-pick or
    a revert resolved in a clone other than the one reporting stays
    invisible to both, which the coverage statement names;
  - *unknown*, otherwise.

  The share is taken over the conflicted and observed-clean pull requests,
  and the figure states its coverage, the part of the cohort they make up.
  The scoreboard withholds the verdict (`not-measured`) below the coverage
  floor set in the fleet-health file, and also whenever the unknown pull
  requests could change it: the whole cohort's share lies between counting
  every unknown one clean and counting every one conflicted, and a verdict
  is given only when both ends reach the same one. That is the rule its
  other figures on an incomplete population follow (the late-round and
  self-inflicted shares), so a floor met by a narrow margin cannot let the
  unmeasured part decide the verdict. `drive-pr`'s cross-PR scoreboard (`fractal-metrics.ts`, M11's
  runnable form) reads the report's JSON as one more figure, judged against
  a baseline in the fleet-health file like its others, so a repository has
  one scoreboard of its process, not two.
- A hotspot becomes a finding in the
  [reflection store](../plugin/skills/reflect/README.md), with its cause as
  the finding's class, so the existing loop (`review-reflections` grouping
  findings and escalating a recurring class to one tracker issue) turns it
  into a change. No second escalation path is built.

### The plan and the roadmap

One file per roadmap item, assembled into ROADMAP.md the way change notes
are assembled into the changelog, removes the `append` and `adjacent`
causes from those pages. The conflicts the replay found there were
`overlap` (two branches changing the same item) and the one-time split of
the plan from the roadmap, which one file per item would not have prevented.
The split is therefore decided by the measure: when the report shows
`append` or `adjacent` hotspots in the plan or the roadmap, one file per
item, holding both the plan's text and the roadmap's, becomes a plan item of
its own. It would also settle the open decision on the plan-file tracker
format (one file for the whole plan, or one per item).

## Build order

1. **Replay, causes and report**: `history.ts` with the report above,
   tested on scratch repositories built to produce each cause, and run on
   Jig's history as the first reference.
2. **Live record**: `resolve-conflicts` appends the events when it concludes,
   and writes each path's cause into its `Conflicts resolved:` section;
   `drive-pr` marks the resolutions its conflict-resolve round starts.
3. **The practice**: M11's event type and metric, the scoreboard's new
   figure, M12's practice text, mappings and audit criterion, and the audit
   running the replay.
4. **Into the learning loop**: hotspots as reflection findings.

## Left out

- **`git rerere`'s cache.** It holds conflicts resolved during rebases, but
  without paths or dates, and only where it is turned on.
- **The forge's merge-conflict state.** GitHub reports whether a pull request
  conflicts, not which files or why; the replay reads the same fact from git.
- **Other friction from the same sources**: how often a branch takes its
  base again before it merges, review rounds per pull request, CI re-runs,
  gates that pass on a machine and fail in CI, sessions stopped by a turn
  cap. Each is a cost of parallel work that the event types above can grow to
  hold; each becomes a plan item when a repository needs it.
