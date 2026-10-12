---
name: review
description: "Review a diff, a plan or a pull request against the repository's standards in tiers (pattern checks, contract checks, semantic review); use before pushing, before opening a pull request, or to check a change against the repository's architecture decisions."
argument-hint: "[files...] [--tier=N] [--quick] [--skip-t3] [--pr]"
context: fork
---

# Review orchestrator

A systematic review that detects the kinds of artifact a change touches (a
database migration, an API endpoint, frontend code, a plan document, …) from
the diff and runs [tiered checks](https://github.com/docomply/jig/blob/main/GLOSSARY.md) against the repository's
standards: its architecture decision records
([ADRs](https://github.com/docomply/jig/blob/main/GLOSSARY.md): short numbered documents
that each record one design decision and its reason, Groundwork module
[M5](https://github.com/docomply/jig/blob/main/modules/M5-adr-practice/README.md)) and
their machine-readable rules, its
[change-area catalog](https://github.com/docomply/jig/blob/main/GLOSSARY.md) (one file
mapping path patterns to named areas of the codebase and what a change to each
implies, Groundwork module
[M3](https://github.com/docomply/jig/blob/main/modules/M3-change-area-catalog/README.md)),
and its specialist review skills.

It is the runnable form of the author-side tiered review in Groundwork module
[M7 (PR lifecycle & review)](https://github.com/docomply/jig/blob/main/modules/M7-pr-lifecycle-review/README.md):
the review a change gets before it is pushed, ahead of the pull request's own
reviewers.

Groundwork maintains this procedure and ships it in the `groundwork` plugin.
Each repository supplies its own values: its rules, its catalog, its
specialist skills and its base branch. Where this file names a configured
value, it comes from `.config/groundwork-overlay.yaml` in the repository under
review, read from its base branch; see [Consumer configuration](#consumer-configuration)
and [Policy comes from the base branch](#policy-comes-from-the-base-branch-not-the-change-under-review).

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string. Sibling skills are reached
the same way, e.g.
`${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/list-unresolved-threads.ts`.

Run every command from the root of the repository under review, except where
a command below says to run it inside the base snapshot (see
[Policy comes from the base branch](#policy-comes-from-the-base-branch-not-the-change-under-review)).
Never `cd` into the skill directory.

### Consumer configuration

Every field is optional. Read them from the base branch's copy of
`.config/groundwork-overlay.yaml` (see the next section):

| Field | What it sets | When absent |
|-------|--------------|-------------|
| `repository.base_branch` | The branch the change is compared against (`origin/<branch>`) | The clone's `origin/HEAD` when it has one, else `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` |
| `adr.rules_file` | Path, from the repository root, to the machine-readable ADR rules file (`pattern_rules`, and optionally `semantic_rules` and `artifact_detection`) | Detected: the one tracked file named `adr-rules.yaml`, `.adr-rules.yaml` or `adr-rules.yml`, or `rules.yaml` or `rules.yml` inside an `adr-rules/` directory, outside test fixtures and templates. No file: Tier 1 runs the generic checks only and says so in the summary |
| `drive.validation_plan_command` | The command that reads the changed files (one per line) on stdin and prints the validation plan as JSON, including `reviewSkills` (mandatory specialist review skills) and optionally `postDeploy` | No plan command: resolve the catalog by hand (below), or there are no catalog-mandated specialist gates |
| `drive.change_areas_catalog` | Path to the change-area catalog (YAML whose `areas:` map holds area key → `{paths, impliedBy, review: {skills}, postDeploy, …}`) | No catalog: skip the catalog steps and say so in the summary |
| `review.bots` | The logins of the repository's AI reviewers | No AI reviewer is assumed |
| `issue_tracker.team` | The key the tracker's issue identifiers carry (`ENG` for `ENG-123`), used to recognise the issue a deferral names | A deferral must still name its issue; any issue key or link counts |

### Policy comes from the base branch, not the change under review

The change under review cannot define the rules it is reviewed against
(Groundwork module M7). Otherwise a change could weaken an ADR rule, drop a
specialist gate from the catalog or edit a detector command, and then pass
its own review. So the review policy is the copy on the base branch (or on an
independent source the repository configures, such as a pinned release), and
the reviewed tree is only the input being reviewed.

**The invariant: every policy input is resolved inside a trusted snapshot of
the base branch; the change contributes only data.** Policy inputs are the
overlay file and every value read from it (the `adr.rules_file` path
included), the discovery of a rules file or catalog that is not configured,
the ADR rules file, the change-area catalog, the specialist review skills,
and every command this procedure runs: the validation plan command, rule
detectors, the ADR rule check and the contract checks, together with the
scripts and runtime configuration they load. Data is the contents of the
reviewed tree's files and the list of files the change touches. Choosing
*which* policy applies is itself policy: a step that reads the reviewed tree
to pick a path or to discover a file breaks the invariant as surely as one
that reads the rules from there, because a change could point
`adr.rules_file` at a weaker file that also exists on the base branch, or
move its rules file out of discovery.

Two rules carry the invariant into every command below; a step that breaks
either one leaks the reviewed tree into policy:

- **A policy command's inputs are enumerated, not filtered.** Nothing ambient
  from the reviewed tree or from the caller's session reaches a command that
  applies policy (the ADR `locate.ts` script, the M5 rule check, the
  validation plan command, any rule detector or contract check). Removing
  the variables known to be dangerous does not hold: the groundwork scripts
  read the repository and overlay from `GROUNDWORK_*` variables, git reads
  `GIT_DIR` and its siblings, the rule check reads its window and strictness
  from the environment, and Bun loads a `.env` file and a `bunfig.toml` from
  the current directory on its own, so each new reader is one more variable
  to forget. Instead, each such command starts from an empty environment
  (`env -i`) and receives only these values:

  | Variable | Value |
  |----------|-------|
  | `PATH`, `HOME` | the caller's, so that tools are found; `PATH` must not name a directory inside the reviewed tree |
  | `GROUNDWORK_CONSUMER_ROOT` | `<base-tree>` |
  | `GROUNDWORK_OVERLAY` | `<base-tree>/.config/groundwork-overlay.yaml` |
  | `RULES` (rule check only) | `<base-tree>/<rulesFile>` |
  | `WINDOW`, `STRICT` (rule check only) | left unset, so the check's defaults apply (a two-line `follow_check` window, warnings not counted as failures), unless the base branch's own gate definition sets them: then the values written there, read from `<base-tree>` |

  Every Bun invocation also takes `--no-env-file`, so no `.env` file is
  loaded, and `--config=<bunfig>`, so the base snapshot's runtime
  configuration applies instead of the current directory's (a `bunfig.toml`
  can name a `preload` script that runs before the command). Give any other
  runtime that reads configuration or environment files from the current
  directory the same treatment. The shape, with the command's own arguments
  after it:

  ```bash
  env -i PATH="$PATH" HOME="$HOME" \
    GROUNDWORK_CONSUMER_ROOT="<base-tree>" \
    GROUNDWORK_OVERLAY="<base-tree>/.config/groundwork-overlay.yaml" \
    bun --no-env-file --config="<bunfig>" <script> <arguments>
  ```

- **One effective file list, separated by null bytes, built and checked
  once.** The list of files under review is collected once during setup
  (step 3) and every later step reads only that list: classification, the
  catalog, the rule checks and Tier 1. Git writes a path with a non-ASCII
  byte (`src/café.ts`) quoted and escaped unless asked for null-terminated
  output (`core.quotePath`), so a list held one path per line names files
  that do not exist. Produce the list with `-z` (`git diff -z --name-only`,
  `git ls-files -z`), store it in a file rather than a shell variable, and
  consume it with `while IFS= read -r -d '' f` or `xargs -0`. A path that
  contains a newline is rejected when the list is built, which stops the
  review: some commands take one path per line (the validation plan command
  does), and there such a path would split into two records naming files
  that do not exist.

Set up once per review:

1. **Resolve the base once.** First resolve the default branch, the same way
   the configuration table does: the clone's `origin/HEAD` when it has one,
   else the name GitHub reports. Read the overlay from that branch's copy,
   never from the change:

   ```bash
   if default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD); then
     default=${default#origin/}
   else
     default=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
   fi
   [ -n "$default" ] || { echo "ERROR: cannot resolve the default branch" >&2; exit 1; }
   git fetch origin "$default" &&
     git show "origin/$default:.config/groundwork-overlay.yaml"
   ```

   An overlay absent on the default branch means every field takes its
   default. `<base>` is then the pull request's own base when reviewing a
   pull request (`gh pr view <PR> --json baseRefName -q .baseRefName`), else
   that overlay's `repository.base_branch`, else the default branch. Every
   later step uses this `<base>`; none resolves it again.
2. **Check out the base snapshot.** Create a temporary, detached checkout of
   it and remove it when the review ends. `<base-tree>` below stands for its
   absolute path, `<effective-files>` for the absolute path of a temporary
   file outside both trees that holds the effective file list, and
   `<bunfig>` for `<base-tree>/bunfig.toml`, or, when the base branch has
   none, an empty file outside both trees (Bun refuses a `--config` path
   that does not exist):

   ```bash
   git fetch origin "<base>"
   git worktree add --detach "<base-tree>" "origin/<base>"
   [ -f "<base-tree>/bunfig.toml" ] || : > "<bunfig>"
   # when the review ends:
   git worktree remove --force "<base-tree>"
   rm -f "<effective-files>" "<bunfig>"   # the last only when it was created
   ```

3. **Collect the effective file list once.** With `--files`, the named
   files are the list, exactly as given and relative to the reviewed tree's
   root. Otherwise it is the cumulative change: everything the branch
   changes since it left the base branch, committed or not, tracked or
   untracked, so a pull request with a clean working tree still yields its
   full change set. Then reject any path containing a newline. From the
   reviewed tree's root:

   ```bash
   set -o pipefail
   if [ "$#" -gt 0 ]; then   # the --files arguments, one per positional parameter
     printf '%s\0' "$@" | sort -zu > "<effective-files>"
   else
     VALIDATION_BASE=$(git merge-base "origin/<base>" HEAD) || { echo "ERROR: cannot resolve merge-base against origin/<base>" >&2; exit 1; }
     { git diff --no-renames --name-only -z "$VALIDATION_BASE" &&
       git ls-files --others --exclude-standard -z; } | sort -zu > "<effective-files>"
   fi || { echo "ERROR: cannot collect the files under review" >&2; exit 1; }
   if [ "$(tr -cd '\n' < "<effective-files>" | wc -c)" -ne 0 ]; then
     echo "ERROR: a file under review has a newline in its path; rename it, then review again" >&2; exit 1
   fi
   ```

   The list includes deleted files. They count for classification (deleting
   a migration is a migration change) and for the catalog, but have no
   content to check: content checks take only the entries that are still
   files in the reviewed tree, and the deletion itself is reviewed as part
   of the diff. The filter that keeps those entries skips the others
   explicitly, so a deleted last entry, or a change that only deletes, still
   leaves the pipeline successful:

   ```bash
   while IFS= read -r -d '' f; do if [ -f "$f" ]; then printf '%s\0' "$f"; fi; done < "<effective-files>"
   ```

   Each step below that names `<effective-files>` means this list. To read
   it, `tr '\0' '\n' < "<effective-files>"` prints one path per line.
4. **Resolve configuration inside the snapshot.** Read the overlay from
   `<base-tree>/.config/groundwork-overlay.yaml`, and locate the ADR rules
   file, configured or detected, by running the `/groundwork:adr` skill's
   script inside the snapshot with the enumerated environment, so both the
   configured path and the discovery come from the base branch:

   ```bash
   cd "<base-tree>" &&
     env -i PATH="$PATH" HOME="$HOME" \
       GROUNDWORK_CONSUMER_ROOT="<base-tree>" \
       GROUNDWORK_OVERLAY="<base-tree>/.config/groundwork-overlay.yaml" \
       bun --no-env-file --config="<bunfig>" "${CLAUDE_SKILL_DIR}/../adr/scripts/locate.ts"
   ```

   Read `rulesFile` from its output; the rules are
   `<base-tree>/<rulesFile>`, and the catalog is
   `<base-tree>/<drive.change_areas_catalog>`. A non-zero exit means the
   configured path does not exist on the base branch or several rules files
   match there: report the message and stop.
5. **Run policy commands from the snapshot, over the reviewed data.**
   Commands, specialist skills and their scripts are the base snapshot's
   copies, and each runs with the enumerated environment. A command that
   reads only the file list (the validation plan command) runs inside
   `<base-tree>` with the list on its standard input. A command that reads
   file contents runs from the reviewed tree's root, because the reviewed
   files and their repository-relative paths are there, but takes its
   script and its rules from the snapshot by absolute path. The M5 ADR rule
   check (`adr-rules-check.ts`) shows why the paths must stay
   repository-relative: it opens each argument relative to the current
   directory, silently skips an argument that is not a file, and matches
   each rule's `exclude` globs against the argument as given. Run from the
   snapshot with the same paths, it would check the base branch's old copies
   and skip every added file; given absolute paths, no anchored exclusion
   (`scripts/**`, say) would match. Running from the reviewed tree's root is
   also where that tree's own `.env` and `bunfig.toml` sit, which is why the
   environment is enumerated rather than inherited. So, from the reviewed
   tree's root:

   ```bash
   (
     set -o pipefail
     while IFS= read -r -d '' f; do if [ -f "$f" ]; then printf '%s\0' "$f"; fi; done < "<effective-files>" |
       env -i PATH="$PATH" HOME="$HOME" \
         GROUNDWORK_CONSUMER_ROOT="<base-tree>" \
         GROUNDWORK_OVERLAY="<base-tree>/.config/groundwork-overlay.yaml" \
         RULES="<base-tree>/<rulesFile>" \
         xargs -0 bun --no-env-file --config="<bunfig>" "<base-tree>/<path to adr-rules-check.ts>"
   )
   ```

   When no file is left to check, `xargs` runs the check once with no
   arguments (it reports nothing to check) or, on macOS, not at all; either
   way the step succeeds.

A policy file the change adds or edits is a proposed policy change: review
its diff as part of the change (a weakened rule or a removed gate is itself a
finding), but do not apply it to this review. A policy file absent on the
base branch means there is no established policy of that kind yet; say so in
the summary.

## Quick start

```bash
# Review uncommitted changes (most common)
/groundwork:review

# Review specific files
/groundwork:review src/orders/orders.service.ts

# Tier 1 only (fast pattern checks)
/groundwork:review --tier=1

# Review a plan document
/groundwork:review docs/plans/checkout-redesign.md

# Full pull request review
/groundwork:review --pr
```

## Tier overview

| Tier | Model | Time | Purpose |
|------|-------|------|---------|
| 1 | a fast, inexpensive model | under 5 seconds | Pattern matching: the ADR rules' patterns, naming checks |
| 2 | a mid-size model | about 2 minutes | Contract validation: schema drift, API description freshness, shared-type sync, data-isolation filters |
| 3 | the strongest available model | about 10 minutes | Semantic review: specialist review skills, design review, state-machine and other semantic rules |

## Workflow

### Step 1: Detect artifact types

Classify `<effective-files>`, the list collected during setup (see
[Policy comes from the base branch](#policy-comes-from-the-base-branch-not-the-change-under-review)):
the files named with `--files`, else the cumulative change set. Never
classify a fresh diff against `HEAD` or the index: those see only
uncommitted work, so a committed branch with a clean working tree would yield
no artifact types and skip every tier.

When the ADR rules file has an `artifact_detection` map (artifact type →
`patterns` globs and `applicable_rules`), it is the classification: a changed
file belongs to every type whose patterns it matches. Without one, classify by
the repository's own layout, using these generic types:

| Type | What it covers | Tiers |
|------|----------------|-------|
| `db_migration` | database migration files | 1, 3 |
| `api_endpoint` | route handlers, request and response schemas, the API description | 1, 2, 3 |
| `backend_code` | server-side source | 1, 2, 3 |
| `frontend_code` | user-interface source | 1 |
| `plan` | plan and design documents | 1, 3 |
| `catalog` | the change-area catalog (`drive.change_areas_catalog`) and its tooling | 1, 3 |

**When reviewing an existing pull request** (`--pr`, or a pull request
already open for this branch), read prior findings before starting Tier 1:

```bash
bun "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/list-unresolved-threads.ts" <PR>
```

Not `gh pr view <PR> --comments`, which returns only top-level conversation
comments and silently omits every inline review thread, including blocking
ones.

**Resolve the catalog for every review, not only catalog changes.** The table
above routes tiers; it does not route specialist gates. Those come from the
catalog, so the resolver runs unconditionally: a one-line frontend diff
follows the frontend row to Tier 1 only, and would otherwise skip a
catalog-mandated design-language review, exactly as an infrastructure diff
would skip its infrastructure review.

Use the same `<effective-files>` list. Substitute `<catalog>`
(`drive.change_areas_catalog`, from the base snapshot's overlay) and
`<validation_plan_command>` (`drive.validation_plan_command`, likewise):

```bash
# Check if the catalog is in the diff. grep reads the list file itself, one
# null-terminated entry at a time (-z), rather than from a pipe: `-q` exits at
# the first match without draining its input, and under `pipefail` the
# SIGPIPE that leaves a still-writing producer would report a failure even
# though grep matched.
grep -qzxF "<catalog>" "<effective-files>" && echo "catalog_changed"

# Resolve the change areas of the files under review inside the snapshot,
# with the enumerated environment. The plan command's contract is one path
# per line on its standard input, so the list is converted at that boundary
# only (setup step 3 has already rejected any path containing a newline).
# When the command runs bun, add `--no-env-file --config="<bunfig>"` to it.
tr '\0' '\n' < "<effective-files>" |
  (cd "<base-tree>" &&
    env -i PATH="$PATH" HOME="$HOME" \
      GROUNDWORK_CONSUMER_ROOT="<base-tree>" \
      GROUNDWORK_OVERLAY="<base-tree>/.config/groundwork-overlay.yaml" \
      sh -c '<validation_plan_command>')
```

When the repository declares a catalog but no plan command, resolve it by
hand: the seed areas are those whose `paths` globs match a changed file; add
every area whose `impliedBy` lists an area already in the set, until nothing
changes; the review skills are the union of the areas' `review.skills`, and
the post-deploy actions the union of their `postDeploy`.

Invoke every skill in the resolved, deduplicated `reviewSkills` once and fold
its findings into the review output. These are mandatory specialist gates: a
blocking result blocks the review, regardless of which tiers the artifact
table selected. Append any `postDeploy` entries to the pull request body under
`## Post-Deploy Actions`, as a warning if they are missing.

**Additionally**, when `catalog_changed` printed above, or when the
repository's catalog lint reports that a consumer file references area keys
from the catalog, run the repository's catalog impact check, if it has one,
and append the impact report. Findings from the catalog's own validation
check (schema and graph checks) are critical: a Tier 1 block.

### Step 2: Load applicable rules

Read the ADR rules file (the single source of truth for rule definitions,
loaded from the base branch as above) to determine which rules apply to the
detected artifact types: the `applicable_rules` of each matched
`artifact_detection` type. Without that map, every pattern rule applies to
each changed file its `exclude` globs do not exclude, and every entry in
`semantic_rules` applies when the diff does what its `trigger` describes.

### Step 3: Run tiered checks

**Tier 1, pattern checks (fast model):** run the applicable rules' patterns
with grep or a regular expression against the files in `<effective-files>`,
skipping only the files each rule's own `exclude` globs carve out. A
`require-nearby` rule (one with a `follow_check`) is violated when its `pattern` matches without the companion
pattern within a few lines. When a rule names a `detector` command, that
command is authoritative for the part of the rule it covers; a clean grep of
the `pattern` alone never clears such a rule. If the repository wires its ADR
rule check as a command (often inside its gates), run the base snapshot's copy
of it over `<effective-files>`, as setup step 5 shows, instead of
hand-grepping. Critical violations **block** further progress.

```bash
# Example quick checks over the listed files that still exist. grep exits 1
# when nothing matches, which is a clean result here, and 2 on an error (an
# unreadable file, say). An error from any grep in any iteration fails the
# block, after every file has been checked.
(
  status=0
  while IFS= read -r -d '' f; do
    if [ -f "$f" ]; then
      grep -Hn "console\.log(" -- "$f" || { rc=$?; [ "$rc" -eq 1 ] || status=$rc; }
      grep -Hn ": any\|as any" -- "$f" || { rc=$?; [ "$rc" -eq 1 ] || status=$rc; }
    fi
  done < "<effective-files>"
  exit "$status"
)
```

A grep hit is not itself a finding. Read it against the rule's own scope and
the repository's instructions on which standards apply to which kinds of file
before flagging: test files, fixed historical or sentinel values, and one-shot
command-line entry points are commonly out of a rule's scope.

**Every tier: a deferral names a filed issue.** If the diff, its pull request
body or a comment defers scope ("out of scope", "separate issue", "follow-up",
"TODO", "phase 2"), it must name the tracker issue it defers to (the key
carries the repository's `issue_tracker.team`, e.g. `ENG-123`). An unnamed
deferral is not a deferral but a disappearance: the work it carves out is
never filed, and the gap it leaves ships as if it were closed. Flag every
unnamed deferral as a warning and require either a filed issue or its
removal.

**Tier 2, contract validation (mid-size model):** run the repository's own
contract and drift checks for the artifact types present, in parallel. For
example:

- database schema drift: the live schema against the committed schema file;
- generated API description freshness, and any policy on what the API
  surface may expose;
- hand-written type mirrors of a schema across a client and server boundary;
- data-isolation filters on queries, in a repository that keeps several
  customers' data in one database;
- when the diff touches documentation: claims whose cited source moved or no
  longer resolves, if the repository checks documentation claims.

Generated-artifact freshness is Groundwork module M2's practice; use the
checks the repository has. Each check keeps the blocking status the
repository gives it: a failing check that is one of its gates, a required CI
status, or a rule marked `critical` blocks the review; findings from any other
check are warnings (non-blocking).

**Tier 3, semantic review (strongest model):** triggered conditionally:

- `db_migration` detected → invoke the repository's database-migration review
  skill, if it has one (mandatory).
- `api_endpoint` detected → invoke the repository's API review skill, if it
  has one (mandatory for breaking changes).
- `catalog` detected → run the catalog impact check (validate the catalog's
  invariants and surface its post-deploy runbook).
- State-transition code → verify it against the repository's state-machine
  decisions, if it has any.
- Plan document → spawn a design reviewer: a subagent briefed as the
  architect, with the plan and the ADRs it touches.
- **Any applicable semantic rule** (an entry in the ADR rules file's
  `semantic_rules`, selected in Step 2) → verify it directly against its own
  `trigger` and `prompt`, including a rule that no dedicated skill owns. This
  is the general case the bullets above are instances of. When the rules file
  has an `artifact_detection` map, a semantic rule is reachable only when a
  detected type's `applicable_rules` lists it: one that no group lists is dead
  weight, so add it to a group in the same change. Without the map, each
  rule's `trigger` alone decides.

Mandatory reviews must approve before merge.

### Finding quality bar

Review committed and uncommitted changes together. Do not report pre-existing
issues unless this change makes them worse or relies on them.

Report every issue this change introduces or exposes, including ones you are
unsure of, each tied to a concrete file and line (or explicitly marked
non-inline rather than dropped), written concisely with scenario, impact and
concrete fix guidance, and tagged with a severity (`CRITICAL`, `WARNING` or
`INFO`) and your confidence. The Step 4 verdict and the exit criteria do the
filtering, not this bar. Take style and formatting judgments from the
repository's formatter and linter output, not from hand-rules, and cite the
relevant ADR number on critical violations.

### Step 4: Aggregate results

Output a unified report:

```
REVIEW SUMMARY
──────────────────────────────────────────────
Artifacts Reviewed: <N files>
Types: <artifact_type (count), ...>

Tier 1 (Patterns):      ✅ PASSED | ❌ BLOCKED  (rules checked: N, violations: N)
Tier 2 (Contracts):     ✅ PASSED | ⚠️ WARNINGS | ❌ BLOCKED  (per-check status)
Tier 3 (Semantic):      ✅ APPROVED | ⏭️ N/A | ❌ REJECTED

VERDICT: APPROVED | APPROVED WITH WARNINGS | BLOCKED
Action:  <next step if not APPROVED>
```

If there are no findings, say so explicitly rather than reporting silence as
a clean bill, and mention any residual test or validation gaps (a skipped
Tier 3 gate, a remote test box not run, a missing rules file or catalog)
alongside the clean verdict.

**Anchoring the findings to code: the surface order.** The summary block above
is the guaranteed surface: it is printed in every session and always contains
every finding, anchored or not. What happens next depends on context:

1. **A pull request exists for this branch.** Its inline review threads carry
   a resolved state and accept the outcome-prefixed replies
   `/groundwork:resolve-review-comments` needs, but nothing here posts *this
   run's* findings to them: there is no handoff from this skill into a pull
   request thread. The repository's AI reviewer (`review.bots`), if it has
   one, runs its own independent review on pushes, on its own cadence and
   coverage. A harness review command that posts inline comments (Claude
   Code's `/code-review --comment`, for one) likewise runs a fresh review of
   the diff and posts *that* review's findings once the pull request is
   Ready, whether a human marked it Ready or `/groundwork:drive-pr` did after
   its first completed round. Neither replays this run's Tier 1–3 findings.
   Treat the pull request's inline threads and this skill's summary block as
   two independent reviews, not a pipeline. Do **not** post from here.

   A findings panel with no resolved or unresolved state cannot carry the
   outcome-prefixed replies `/groundwork:resolve-review-comments` requires,
   which is why the pull request's review threads are the surface for
   anchored findings.
2. **No pull request yet.** The summary block above is the intended terminal
   state, not a fallback awaiting some other surface. Do not invent a local
   review file. The anchored surface is reached by pushing the branch and
   opening the draft pull request, which is cheap where paid external review
   bots stay parked until a pull request is marked Ready. In a terminal
   multiplexer pane, the summary survives a context compaction only while it
   remains in the pane's recent scrollback, and further pane output pushes it
   out. To recover it reliably, read the pane's scrollback with an explicit
   line bound large enough to cover the summary, while the pane is idle
   (Herdr, for one: `herdr agent read <target> --source recent-unwrapped --lines <N>`;
   its default `herdr pane read <pane> --source recent` window is short).

Never post these findings to GitHub by hand: this skill deliberately carries
no recipe for posting a review through the API. If a finding from this run
needs to be visible on the pull request, get it there through a review that
runs against the pull request itself (the AI reviewer's next pass, or a
harness review command with inline comments) rather than assuming either one
will restate it; case 1 above says why neither does.

## Rule reference

The full rule tables (critical rules, warning rules, artifact-to-rule
mapping) are derived from the ADR rules file, the single source of truth for
rule definitions. Its basic shape (`pattern_rules` with `id`, `adr`,
`severity`, `pattern`, `follow_check`, `exclude`, `message`, `fix_hint`) is
Groundwork module M5's `adr-rules.yaml` template; this skill also reads, when
present, a rule's `tier` and `detector`, a `semantic_rules` list (Tier 3
rules, each with a `trigger` and a `prompt`; a `tier` field on them is
optional), and an `artifact_detection` map.

## Options

| Flag | Description |
|------|-------------|
| `--tier=N` | Run only tier N (1, 2, or 3) |
| `--pr` | Full pull request review mode |
| `--files=...` | Review exactly these files instead of the cumulative change: every step reads only them |
| `--quick` | Alias for `--tier=1` |
| `--skip-t3` | Skip the Tier 3 semantic review |

## Exit criteria

- **`APPROVED`:** Tier 1 critical rules pass, no Tier 2 findings, Tier 3
  approved (if applicable).
- **`APPROVED WITH WARNINGS`:** Tier 1 passes, every blocking Tier 2 check
  passes and only non-blocking Tier 2 warnings remain, Tier 3 approved.
- **`BLOCKED`:** any Tier 1 critical violation, or a failing blocking Tier 2
  check, or a Tier 3 mandatory review not approved, or a breaking API change
  whose consumers are not updated in the same change.

## Integration

```
before opening a pull request → /groundwork:review → Tier 1 blocks if critical → Tier 2 blocks on a failing blocking check, other warnings in the PR body → Tier 3 required for db/api
/groundwork:do-item <issue> → runs the same tiers as its pre-PR code review gate
CI: the repository's ADR rule check, pattern tier only
```
