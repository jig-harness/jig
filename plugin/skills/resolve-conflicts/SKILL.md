---
name: resolve-conflicts
description: "Resolve the conflicts of a stopped merge, rebase or cherry-pick so both sides' intent survives: map the sides and why each changed, resolve per kind of file, record every decision, check for dropped changes, validate, then conclude; use when a merge, rebase or cherry-pick stops on conflicts, including drive-pr's conflict-resolve round; or to report where past merges conflicted and why."
argument-hint: "[base-branch]"
allowed-tools: "Read Edit Write Grep Glob Bash(git *) Bash(gh pr view *) Bash(bun *)"
---

# Resolve conflicts

When git combines two lines of work (a merge, a rebase, a cherry-pick or a
revert) and both changed the same lines, it stops and leaves the file with
**[conflict markers](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)**
around each region it could not combine. Resolving them by reading the markers alone fails in recurring ways: one side's change is
silently dropped (taking one side's whole file also discards that side's
other edits git had already merged cleanly), "ours" and "theirs" are confused
(in a rebase they mean the opposite of a merge), lockfiles are merged line by
line instead of being rebuilt, the resolver never learns *why* each side
changed the code, nothing tells a reviewer what was decided, and a genuine
product disagreement is settled by an agent without anyone noticing.

This skill gives the resolution a structure and checks it before it is
concluded. It belongs to the pull-request lifecycle of Jig module
[M7 (PR lifecycle & review)](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md):
a pull request that conflicts with its base cannot merge, and the resolution
is part of the change its reviewers see.

**The invariant.** A conflict resolution keeps the intent of both sides, or
records which side's change it dropped and why. Derived files (lockfiles and
[generated artifacts](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md))
are regenerated from their resolved sources, never merged by hand. Every
decision is recorded where reviewers see it: the merge commit message. Only
changes attributable to the operation may be staged for its commit.
Repository obligations apply to the entire resolved diff, including parts
git merged without a conflict. The resolution is validated before it is
concluded and pushed. A conflict whose right answer is a product decision
goes to a human.

Jig maintains this procedure and ships it in the `jig` plugin.
A repository adds its own generated files and merge obligations in `.config/jig.yaml`
(the [consumer overlay](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)),
and the skill also reads the `generated:` entries of its change-area catalog
(`drive.change_areas_catalog`), so a generator declared there is not stated
twice; without that file the skill works on its defaults.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Git 2.41 or newer is required: to reconstruct the automatic merge result
without trusting already staged content, and to read every attribute from
the staged `.gitattributes` files alone (`git --attr-source`).
Cherry-picking or reverting a merge commit with `-m` is unsupported: Git
does not reliably retain the selected parent for reconstruction. The mapper
refuses it before writing a snapshot; resolve and validate that operation
manually. Merges recreated by
`git rebase --rebase-merges` are supported through their replayed parents.

Run every command from the root of the repository with the conflicts. Never
`cd` into the skill directory: the scripts find the repository, its
configuration and the operation in progress from the working directory.

## Arguments

`$ARGUMENTS` — optional: the base branch to bring the current branch up to
date with (Step 1). Without it, the skill works on the merge, rebase,
cherry-pick or revert that has already stopped.

## Terms

**Ours and theirs** are git's names for the two sides of a conflict. Their
meaning depends on the operation; `conflict-map.ts` states the role of each
side so you never have to work it out:

| Operation | `ours` is | `theirs` is |
|-----------|-----------|-------------|
| merge | the checked-out branch | the branch being merged in |
| rebase | the upstream being rebased onto, plus this branch's commits already replayed | this branch's commit being replayed |
| cherry-pick | the checked-out branch | the commit being picked |
| revert | the checked-out branch | the state before the commit being reverted |

The **[merge base](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)** is the commit both sides started from; a side's *change*
is what it did relative to the merge base. The **integration side** is the
side that carries the base branch or upstream: `theirs` when you merge the
base branch into a feature branch, `ours` in a rebase. Derived files start
from this side before they are regenerated.

## Scripts

| Script | What it does | Exit codes |
|--------|--------------|------------|
| `scripts/conflict-map.ts [--json] [--integration ours\|theirs]` | Maps the stopped operation and writes the snapshot. Read-only otherwise | 0 mapped; 2 usage, not in a git work tree, or invalid configuration; 3 nothing in progress, or the stored snapshot is unreadable (it is never replaced) |
| `scripts/record.ts <path> <decision> [--reason "…"] [--command "…"] [--dropped "…"]` | Records one path's decision in the snapshot | 0 recorded; 2 usage (unknown path or decision, missing reason, no known regeneration command, or `regenerated` for a path that is not a lockfile or generated file); 3 nothing in progress, or no snapshot for this operation |
| `scripts/check-resolution.ts [--json \| --message \| --commit-message]` | Verifies the resolution; prints the commit-message section | 0 passes; 1 problems; 2 usage or invalid configuration; 3 nothing in progress, or no snapshot for this operation; 4 needs a human (wins over 1) |

## Step 1: Start or find the operation

If an operation has already stopped on conflicts, go to Step 2.

**Before merging, only where the repository has opted in.** Fetch the base
and let the changelog skill say whether the branch edited the changelog's
Unreleased or release sections or a version file. It reads the repository's
configuration as the base holds it, so a branch forked before the repository
adopted the skill is covered too:

```bash
git fetch origin <base>
bun "${CLAUDE_SKILL_DIR}/../changelog/scripts/convert.ts" --base origin/<base> --dry-run
```

When it prints `not configured` (the base did not turn the skill on) or
reports nothing to convert, go straight to the merge. When it reports a note,
a file to put back or a placeholder, convert for real and commit the result
before merging, so those files cannot conflict and no resolution made to
another file is thrown away:

```bash
bun "${CLAUDE_SKILL_DIR}/../changelog/scripts/convert.ts" --base origin/<base>
git add -A
git commit -m "chore(changelog): move the branch's changelog edits into a change note"
```

`convert.ts` refuses on uncommitted changes, so commit or set aside anything
else first, and prints `attention:` lines for entries it could not move
cleanly: fix those before committing.

To bring a branch up to date with its base (the `conflict-resolve` round of
[`/jig:drive-pr`](../drive-pr/SKILL.md) is this case), merge the base
in, with a base section in the markers:

```bash
git fetch origin <base>
git -c merge.conflictStyle=zdiff3 merge origin/<base>
```

Never rebase or force-push a branch that has an open pull request under a
drive: the drive syncs by merging, and rewriting the branch's history
invalidates the review state it tracks.

## Step 2: Map the conflicts

Before you change any conflicted file:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/conflict-map.ts"
```

It prints which operation stopped, each side's commit and role, the
integration side and the merge base, and for every conflicted path:

- its **kind**: `both-modified`, `both-added`, `deleted-by-ours`,
  `deleted-by-theirs`, `added-by-ours`, `added-by-theirs` or `both-deleted`;
- its **class**: `lockfile` (by file name), `generated` (by the
  repository's configuration or its change-area catalog), `binary` or `text`,
  with the regeneration command for the derived classes;
- its conflict regions (line ranges);
- the **intent** of each side: the commits that changed the path since the
  merge base (at most 20 per side), and, for a path one side deleted, where
  that side moved it (`renamedTo`).

Read the warning line first when there is one: in a rebase, `ours` is the
upstream. If the merge guessed the integration side wrong (two feature
branches, say), run it again with `--integration ours` or `--integration
theirs`.

Inspect `git diff --cached` before resolving. Every staged path must belong
to this operation, and every staged hunk outside your recorded decisions
must match what git merged automatically. Keep unrelated staged work out of
the operation without discarding it; do not conclude while it is present.

Then read the intent behind every path: the commit messages it lists, and for
a commit whose subject names a pull request, the pull request itself
(`gh pr view <number>`). You are looking for *why* each side changed the code,
which decides the resolution.

Markers without a base section hide what each side changed. While a path is
still unmerged and before you edit it, re-create its markers with one:

```bash
git checkout --conflict=zdiff3 -- <path>
```

`--json` prints the full map, including each region's ours, base and theirs
text.

## Step 3: Resolve each path

Decide from the intents, never from which side "looks newer".

- **Lockfile or generated file.** Take the integration side
  (`git checkout --ours|--theirs -- <path>` for that side), resolve the
  sources it is built from first, then run the regeneration command the map
  printed (in the directory it names) and stage the result. Never edit a
  derived file by hand.
- **Deleted on one side, changed on the other.** Find where the code went:
  `renamedTo`, or a search for the changed symbol. Carry the change there, or
  record why it no longer applies, then `git rm` the old path (decision
  `deleted`) or keep it (decision `ours`, `theirs` or `combined`).
- **Text.** Combine both changes where both intents still hold (`combined`).
  Keep one side only when the other change is superseded by it or already
  contained in it (`ours` or `theirs`). Write new code when neither side
  works verbatim but both intents must be served (`rewritten`).
- **Binary.** Pick a side with a reason, or escalate.
- **A product decision.** When the two sides want incompatible behaviour and
  the code cannot tell you which is right, do not choose: record `escalate`
  with the question (Step 8).

Then look beyond the markers. A clean textual merge can still break a caller
on the other side: search for uses of anything either side renamed, removed
or changed the signature of, and fix them as part of the resolution.

Stage every resolved path: `git add <path>` (or `git rm <path>`).

## Step 4: Record each decision

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" src/a.ts combined --reason "kept the retry limit from main and this branch's new timeout option"
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" src/b.ts theirs --reason "main already renamed the helper this branch edited; the edit moved to src/c.ts"
bun "${CLAUDE_SKILL_DIR}/scripts/record.ts" bun.lock regenerated
```

| Decision | Meaning | Reason |
|----------|---------|--------|
| `combined` | both sides' changes are kept (the default expectation) | optional |
| `ours` / `theirs` | the other side's change is dropped, because this side supersedes or already contains it | required |
| `rewritten` | neither side verbatim: new code serving both intents | required |
| `regenerated` | a derived file (lockfile or generated file) rebuilt by its command; `--command` defaults to the mapped one. Refused for any other path | optional |
| `deleted` | the path is removed; say where a carried-over change went | required |
| `escalate` | needs a human; the reason is the question to put to them | required |

Write each reason for the reviewer, in one or two sentences. A path that
merged cleanly can also need a manual edit: `record.ts` accepts it when it
belongs to the operation and recovers its inputs from the committed sides.
It refuses unrelated paths and conflicted paths whose original snapshot
was lost.
[references/decisions.md](references/decisions.md) has a worked example of
each decision.

The record lives in the snapshot, `$(git rev-parse --git-path
jig/conflicts.json)`, which is never committed. Its shape:

```json
{
  "version": 1,
  "operation": { "kind": "merge", "head": "<sha>", "incoming": "<sha>", "base": "<sha>" },
  "sides": {
    "ours": { "commit": "<sha>", "ref": "feature", "subject": "…", "role": "the checked-out branch (feature)" },
    "theirs": { "commit": "<sha>", "ref": "main", "subject": "…", "role": "the branch being merged in (main)" },
    "integration": "theirs",
    "integrationWhy": "main is the default branch"
  },
  "warning": null,
  "catalogIncomplete": null,
  "mappedAt": "2026-01-01T00:00:00.000Z",
  "paths": {
    "src/a.ts": {
      "kind": "both-modified",
      "class": "text",
      "markerSize": 7,
      "regenerate": null,
      "stages": {
        "base": { "mode": "100644", "blob": "<sha>" },
        "ours": { "mode": "100644", "blob": "<sha>" },
        "theirs": { "mode": "100644", "blob": "<sha>" }
      },
      "hunks": [{ "start": 2, "end": 9, "oursLabel": "HEAD", "baseLabel": "…", "theirsLabel": "main", "ours": "…", "base": "…", "theirs": "…" }],
      "intent": {
        "ours": { "commits": [{ "sha": "<sha>", "subject": "…", "pr": null }], "truncated": false, "renamedTo": null },
        "theirs": { "commits": [{ "sha": "<sha>", "subject": "… (#15)", "pr": 15 }], "truncated": false, "renamedTo": null }
      },
      "resolution": {
        "decision": "combined",
        "reason": "…",
        "command": null,
        "dropped": null
      }
    }
  }
}
```

`resolution` is the part you fill in; `record.ts` writes it, and you may
edit it by hand to the same shape. `regenerate` is
`{ "command", "cwd", "source": "built-in" | "configuration" | "catalog" }` for
a derived file, and `null` for a `generated` path whose catalog entry declares
no command (then `record.ts` needs `--command`). `catalogIncomplete` says why
the generated files the configuration and the change-area catalog declare
could not all be read when the map was written (the configuration was
unmerged, the catalog could not be read, or an entry's `outputs` are
malformed), and keeps the check refusing until a map that reads them all
clears it. `dropped` is `{ "why": "…", "lines": [{ "side": "theirs", "text": "…" }] }`.

The snapshot belongs to one operation (its kind, `HEAD`, and the incoming
commit). Running `conflict-map.ts` again for the same operation classifies
every mapped path afresh (a staged one from its stored conflict stages), maps
paths that are newly unmerged, and keeps each recorded decision while the
path's class and regeneration command are the ones it was recorded under. A
decision recorded under another class or command is cleared, the output names
the path, and you record it again. A snapshot of a different operation is
replaced, and the output says so. Each stop of a
rebase is a different operation. An unreadable snapshot is never replaced
(exit 3): once a path is staged, git no longer knows its conflict stages, and
only the snapshot does. Restore it, or, if nothing has been staged since it
was written, move it aside and map again.

## Step 5: Check the resolution

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/check-resolution.ts"
```

It fails (exit 1), listing each problem with its file and line, when:

1. a path is still unmerged;
2. conflict markers remain in a mapped path, or in any other staged change;
3. a mapped path has no decision, an unknown one, or lacks a required reason;
4. what is staged for a mapped path differs from the working tree. The
   configuration, the change-area catalog (read through the symbolic links the
   index holds; a link whose target leaves the repository is refused, never
   read from disk) and the `.gitattributes` files are read from the index, as the
   commit carries them: a change to one of them takes effect once it is staged,
   and a working-tree change that is not staged, an untracked file, an ignored
   one, a staged link named `.gitattributes`, `$GIT_DIR/info/attributes`, the
   file `core.attributesFile` names or the system's attributes file decides
   nothing. Git's automatic result is reconstructed under no configuration
   but the repository's rename-detection settings (`merge.renames`,
   `merge.directoryRenames`, `merge.renameLimit`, `diff.renames`,
   `diff.renameLimit`), its renormalization (`merge.renormalize`,
   `core.autocrlf`) and `core.useReplaceRefs`, so a merge driver
   configured for the repository, the user, the system or the environment
   does not run. Everything else in the repository's git directory is read
   as it stands: its references (replace refs among them), `HEAD`, the
   index, `shallow`, `info/grafts` and the `modules` directory, in a linked
   worktree too, so a submodule git fast-forwarded is not reported as a
   conflict, whether or not `.gitmodules` is in the working tree. Conflict markers are looked for at the size git wrote them with as
   well, and in other staged changes on every added line, whatever an
   attribute says the file is;
5. a lockfile or generated file is not recorded as `regenerated`, or any
   other path is;
6. a staged path is outside the operation's changed-file set, or its staged
   content does not match git's automatic result and has no recorded decision;
7. **a change is dropped.** For every text path it takes the lines each side
   added relative to the merge base, across the whole file, and looks for each
   in the staged result (trimmed, exact match; blank and punctuation-only
   lines are ignored). A missing line is allowed only when the decision says
   so: the other side's lines under `ours` or `theirs`; anything under
   `rewritten` or `deleted` (reported, not failed; a deleted path reports
   every line either side added); and under `combined`, only lines
   acknowledged with `record.ts <path> combined --dropped "<why>"`, which
   records the lines missing at that moment. An acknowledgement edited by
   hand counts only with a nonempty `why`. A side's own lines under
   its own decision always fail.

Fix what it reports and run it again. Exit 4 means a path is recorded as
`escalate`: go to Step 8. Exit 3 means the snapshot is missing or belongs to
another operation: run `conflict-map.ts`, then record again.

## Step 6: Validate

Read every `resolve_conflicts.obligations` entry reported by
`check-resolution.ts`. Check its `check` text against the **whole staged
diff** (`git diff --cached`), including conflict-free files and hunks git
merged automatically. Record the evidence and outcome for each obligation
in the resolution report. An optional command supplements this review; a
passing command does not establish that its prose obligation is satisfied.
Fix violations, stage and record any manual changes, and repeat Step 5.

Never conclude a merge that does not build. Run the repository's checks over
the resolved tree:

- inside a drive, the round's validation plan from drive-pr
  (`bun "${CLAUDE_SKILL_DIR}/../drive-pr/scripts/round-plan.ts"`), which
  covers the uncommitted tree;
- otherwise the repository's gate command, `gates.command`
  (`bun "${CLAUDE_SKILL_DIR}/../fix-ci/scripts/consumer-config.ts"` prints
  it), or the checks its instruction file names.

If a check fails because of the resolution, fix it, stage it, and run Step 5
again.

## Step 7: Conclude

For a merge, a cherry-pick or a revert, commit with git's prepared message
plus the recorded section. `--commit-message` runs the check again and prints
nothing unless it passes:

```bash
message=$(mktemp)
bun "${CLAUDE_SKILL_DIR}/scripts/check-resolution.ts" --commit-message > "$message" && git commit -F "$message"
rm -f "$message"
```

The section reads:

```
Conflicts resolved:
- src/a.ts: combined — kept the retry limit from main and this branch's new timeout option.
- src/b.ts: theirs — main already renamed the helper this branch edited; the edit moved to src/c.ts.
- bun.lock: regenerated (bun install)
```

For a rebase, save the section (`check-resolution.ts --message`) and run
`git rebase --continue`, which keeps the replayed commit's own message. Every
further stop is a new operation: map, resolve, record and check it again.
When the rebase is done, post the saved sections on the pull request, or
report them to the user when there is none.

Inside a drive, carry on with the drive's own steps (validation and push)
after concluding.

## Step 8: Escalation

A path recorded as `escalate` makes `check-resolution.ts` exit 4 and print
each question.

- **Interactive session:** put each question to the user with the options
  you see (keep ours, keep theirs, a combination you describe), then record
  their answer as the decision and continue from Step 5.
- **Unattended (a drive's repair round):** abort the operation
  (`git merge --abort`, `git rebase --abort`, `git cherry-pick --abort` or
  `git revert --abort`), then verify the tree is clean: `git status --porcelain
  --untracked-files=no` prints nothing and `git rev-parse -q --verify
  MERGE_HEAD` fails. Print the questions on stderr and exit non-zero. That is
  how drive-pr's `conflict-resolve` round hands a conflict to a human.

## What this skill never does

- Force-push, or rebase a branch with an open pull request under a drive.
- Take one side's whole text file (`git checkout --ours` or `--theirs`)
  without recording that decision and its reason.
- Edit a lockfile or generated file by hand.
- Conclude with conflict markers left, or before `check-resolution.ts`
  passes.
- Resolve an `escalate` on its own.

## Configuration

One optional section in `.config/jig.yaml`:

```yaml
resolve_conflicts:
  obligations:
    - check: "All changed callers still use the shared validation helper."
      command: bun run check:validation
  generated:
    - paths: ["docs/index.md", "src/generated/**"]
      command: bun run generate
```

`obligations` defaults to an empty list. Each entry has nonempty `check`
text and an optional nonempty `command`, run from the repository root with
a deadline. The checker reports every obligation; a failed command blocks
conclusion. Each command runs only while every tracked file on disk matches
the staged tree, checked before every command and after the last, with
submodules compared whatever their ignore settings and assume-unchanged or
skip-worktree files compared too, including those inside initialized
submodules. A command that changes the staged tree
or a tracked file stops the commands after it and fails the check, so no
result certifies a tree its command did not see. Text-only entries require the agent's review in Step 6.

Each generated entry's `paths` are globs over repository-relative paths (`*` and `?`
stay within one directory; `**` spans any number; `{a,b}` matches either
alternative; `[...]` matches one character of a class, `[!...]` or `[^...]`
one outside it, and never `/`), and `command` rebuilds them, run from the repository
root. Unknown keys, wrong types and a glob that cannot compile (an
unclosed `{`, a backwards range such as `[z-a]`) are refused with the field
named (exit 2). `hotspot_min_merges` (a whole number, 3 by default) is the
history report's hotspot threshold
([below](#where-past-merges-conflicted-the-history-report)). `JIG_OVERLAY`
points the scripts at another configuration file.

**The change-area catalog is read too.** When `drive.change_areas_catalog`
names a catalog, every `generated[].outputs` path of every area (a literal
file path, matched exactly, never a glob) is a generated file, rebuilt by that entry's `command` (run from the repository root), the
class `generated` and the source `catalog` in the map. The catalog states what
a generator writes once; `resolve_conflicts.generated` is for the files it does
not declare. A path is classified by the first of these that matches:

1. `resolve_conflicts.generated`, in the order written;
2. the catalog's `generated[].outputs`, in the catalog's order;
3. the built-in lockfile table below.

An entry in the list above therefore overrides the catalog and the table, and
the catalog overrides the table. The following problems are reported, never
skipped: a catalog entry with no `command` still claims its outputs as
generated files (never hand-merged) and the map warns that no command is
known, so `record.ts` needs `--command` for it; an entry whose `outputs` are
not a list of literal file paths is named in the warning and its outputs are
classified by the other rules; and a catalog that cannot be read (it may be
among the conflicted paths) is named in the warning while the map goes on
without it. In the last two cases `check-resolution.ts` refuses until a later
map reads every entry. Resolve or correct the catalog first, then run
`conflict-map.ts` again: it reclassifies every mapped path, a staged one
included, gives every derived path the command that now applies, and clears
each decision recorded under a class or command that changed, so
`check-resolution.ts` asks for that path's decision again. The check itself
classifies every mapped path again from the configuration and catalog as they
stand when it runs: a path whose class or command differs from the map's (a
declaration added, changed or removed since the map) fails until the map runs
again, and so does a catalog that cannot be read at that point. A `drive.change_areas_catalog` that is not a path is
refused (exit 2).

Built-in lockfiles, matched by file name in any directory and regenerated in
that directory:

| File | Command |
|------|---------|
| `bun.lock`, `bun.lockb` | `bun install` |
| `package-lock.json`, `npm-shrinkwrap.json` | `npm install --package-lock-only` |
| `pnpm-lock.yaml` | `pnpm install --lockfile-only` |
| `yarn.lock` | `yarn install` |
| `Cargo.lock` | `cargo update --workspace` |
| `go.sum` | `go mod tidy` |
| `uv.lock` | `uv lock` |
| `poetry.lock` | `poetry lock` |
| `Gemfile.lock` | `bundle lock` |
| `composer.lock` | `composer update --lock` |

## Limits

- The dropped-change check compares lines, not meaning. A change that was
  kept but reformatted counts as dropped (record `rewritten`, or acknowledge
  it); a removed line that also exists elsewhere in the file is not noticed.
  The semantic search in Step 3 is still yours to do.
- The conflict-marker size is the size of the markers git wrote into the
  path when it is first mapped (the `conflict-marker-size` attribute, default
  7, when no complete region is found in the file), and stays that size for
  the operation; the check also looks for markers of the size the attributes
  give at check time. Map before editing a conflicted file.
- A `git am` session is not mapped.

## Where past merges conflicted: the history report

Run it to see where a repository's merges keep conflicting and why, before
deciding what to change; it is not part of resolving a conflict.

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/history.ts"               # the last 30 days
bun "${CLAUDE_SKILL_DIR}/scripts/history.ts" --days 90
bun "${CLAUDE_SKILL_DIR}/scripts/history.ts" --since 2026-01-01 --until 2026-03-31
bun "${CLAUDE_SKILL_DIR}/scripts/history.ts" --all --json
```

A bare date (`YYYY-MM-DD`) is a day in UTC: `--since` starts at its
midnight, and `--until` ends after it. A time carries its offset from UTC
(`2026-01-01T09:00:00+02:00`, or `Z` for UTC itself), so no range depends on
the machine's time zone.

It [replays](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) every merge commit the repository's refs reach in the range
(fetched pull-request heads such as `refs/pull/*/head` included; the stash
and a forge's synthetic `refs/pull/*/merge` commits, under `refs/remotes/`
too, left out): it merges the
merge's two parents again with `git merge-tree --write-tree`, which needs no
working tree, in diff3 style so every conflicting region carries its
[merge base](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md). Git's
new objects go to a temporary object directory, removed afterwards, so no
ref, index, working tree or object of the repository changes. Today's
attributes do not reach a past merge: the working tree's and the index's
`.gitattributes` are read from the empty tree instead, and the system's and a
person's attributes files are not read. The exception is
`.git/info/attributes`, which git always reads: a built-in driver
(`merge=union`, `merge=binary`) set there still applies, and the report reads
regions at the `conflict-marker-size` set there, as the running git reads the
value. Every configured merge driver is replaced by `false` and
renormalization (`merge.renormalize`) is off, so no merge driver or filter
command of the repository's runs, whichever file names it. It reads git only and never
fetches: it needs git 2.43 or later, and
refuses a partial clone below git 2.45, which cannot be kept from fetching
the objects it lacks. A merge with more than two parents is skipped; in a
shallow clone, so is a merge whose history the clone cuts (its merge base
hidden), and the report says its results are partial. A merge git cannot
replay (an object missing) is skipped too. Every skipped merge is listed
with its reason.

Each conflicting region gets one cause, the first of these that matches; a
path git reports as conflicting without text regions, including one it names
only in a message (a directory rename's file location), gets `structural` for
the whole path, with git's own kind of conflict (`modify/delete`, `binary`,
…); a lockfile or generated file is `derived` whatever its regions.

| Cause | The region | The change that removes it |
|-------|------------|----------------------------|
| `derived` | the path is a lockfile or a generated file, as `conflict-map.ts` classes it | regenerate it; keep it out of pull requests if a step after the merge can write it |
| `structural` | git reports the conflict without text regions: modify/delete, rename, binary, file/directory, mode (a text conflict whose regions cannot be read is `overlap`) | none from the regions; resolving it stays a decision |
| `echo` | the sides are identical, or one side's edit (adding at least one line) is already in the other, in the same order | keep the side that contains the other; rebuild a branch on its base once the branch it was built on merges |
| `version` | the sides differ only in release versions the changelog skill's release step writes (`changelog.version`, each key configured for the file), at the one place that step writes each and can move it on its own, or in a last-updated date | move the version after the merge; take a date from git |
| `sequence` | both sides only add lines, among them an entry with the same next ordinal, one past the base's highest | identifiers that cannot collide, or one renumbering step |
| `tally` | only numbers differ, and each side's number moved by the lines that side added to the file, or added above the line it names | derive the number where it is used; key a register by name, not line |
| `append` | the base side is empty: both sides added lines at the same place (not in a file both sides added, which had no base) | one file per entry, or a sorted list with one entry per line; in source code the report asks whether it is the same fix written twice |
| `packed-list` | one line in every side, and each side only adds whole items to a list in it, each placed where an item ends or starts and closing every bracket it opens, changing no item or separator; a quoted literal is one item, read as the line's language reads it (in prose a code span runs to the next run of as many backticks; in code a backslash escapes inside a string or template literal), and a line with a quote that closes nowhere, or a code line holding a `/` or a template literal's `${`, is not read (in prose, a closing `and` or `or` may move) | one item per line |
| `adjacent` | the lines each side changed touch but do not overlap | split what changes for different reasons onto lines or files of its own |
| `overlap` | none of the above | two pieces of work changed the same thing: plan them apart, or land one first |

A rule matches only on evidence it can settle, so a region it cannot settle
falls to `overlap`. A merge counts as mechanical when no path is `structural`
and no region is `overlap`.

It prints, for the range: how many merges conflicted of how many; the paths,
most often first, each with its causes and the remedy for its most frequent
one (`--limit <n>` paths, 25 by default, `0` for all); the
[conflict hotspots](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
the paths that conflicted in at least `resolve_conflicts.hotspot_min_merges`
merges (3 by default); each cause's count and remedy; per week, the
conflicted merges by cause; how often each cause was right when a sample of
regions was checked by hand
([references/cause-accuracy.json](references/cause-accuracy.json)); and its
limits. It sees only merge commits that still exist: a conflict resolved
during a rebase, a cherry-pick or a revert, or on a branch deleted after a
squash merge, leaves nothing to replay, and a conflict met again in a later
merge counts again.

`--json` prints the same as a `merge-conflicts/v1` object: `range`,
`shallow`, `totals`, `causes`, `paths`, `hotspots`, `weeks` (every week of the
range, one without a merge as zeros), `confidence`, `limits`, `skipped` (each
with its reason: `octopus`, `shallow` or `replay-failed`), and `merges`, one
record per replayed merge (`operation: "merge"`, its commit, both parents
and the pull-request heads each is the tip of, its date, subject, the pull request and the branches the
subject names, and each conflicted path with its kind (null for a path git
names only in a message),
git's kinds of conflict, class, causes, regions, and the decision and reason
its `Conflicts resolved:` section recorded).

| Exit | Meaning |
|------|---------|
| 0 | the report was printed |
| 1 | a git call failed |
| 2 | usage error, not inside a git repository, invalid configuration, git older than 2.43, or a partial clone with git older than 2.45 |

## Related skills

- [`/jig:drive-pr`](../drive-pr/SKILL.md) runs this skill in its
  `conflict-resolve` round and when its `base-sync.ts` reports a conflict
  (exit 9).
- [`/jig:fix-ci`](../fix-ci/SKILL.md) for checks that fail after the
  merge for reasons the resolution did not cause.
