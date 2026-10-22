---
name: review
description: "Review a diff, a plan or a pull request against the repository's standards in tiers (pattern checks, contract checks, semantic review); use before pushing, before opening a pull request, or to check a change against the repository's architecture decisions."
argument-hint: "[files...] [--tier=N] [--quick] [--skip-t3] [--pr]"
context: fork
---

# Review orchestrator

A systematic review that detects the kinds of artifact a change touches (a
database migration, an API endpoint, frontend code, a plan document, …) from
the diff and runs [tiered checks](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) against the repository's
standards: its architecture decision records
([ADRs](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): short numbered documents
that each record one design decision and its reason, Jig module
[M5](https://github.com/jig-harness/jig/blob/main/modules/M5-adr-practice/README.md)) and
their machine-readable rules, its
[change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (one file
mapping path patterns to named areas of the codebase and what a change to each
implies, Jig module
[M3](https://github.com/jig-harness/jig/blob/main/modules/M3-change-area-catalog/README.md)),
and its specialist review skills.

It is the runnable form of the author-side tiered review in Jig module
[M7 (PR lifecycle & review)](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/README.md):
the review a change gets before it is pushed, ahead of the pull request's own
reviewers.

Jig maintains this procedure and ships it in the `jig` plugin.
Each repository supplies its own values: its rules, its catalog, its
specialist skills and its base branch. Where this file names a configured
value, it comes from `.config/jig.yaml` in the repository under
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

The commands run in PowerShell, Bash and other shells with Bun, Git and
GitHub CLI on `PATH`. Replace placeholders with literal values from the
preceding output. Keep the shipped bootstrap configuration flags: they prevent
the reviewed tree’s Bun configuration or environment files from running
before setup has created the trusted snapshot.

### Consumer configuration

Every field is optional. Read them from the base branch's copy of
`.config/jig.yaml` (see the next section):

| Field | What it sets | When absent |
|-------|--------------|-------------|
| `repository.base_branch` | The branch the change is compared against (`origin/<branch>`) | The clone's `origin/HEAD` when it has one, else the default branch from GitHub repository metadata |
| `adr.rules_file` | Path, from the repository root, to the machine-readable ADR rules file (`pattern_rules`, and optionally `semantic_rules` and `artifact_detection`) | Detected: the one tracked file named `adr-rules.yaml`, `.adr-rules.yaml` or `adr-rules.yml`, or `rules.yaml` or `rules.yml` inside an `adr-rules/` directory, outside test fixtures and templates. No file: Tier 1 runs the generic checks only and says so in the summary |
| `drive.validation_plan_command` | The command that reads the changed files (one per line) on stdin and prints the validation plan as JSON, including `reviewSkills` (mandatory specialist review skills) and optionally `postDeploy` | No plan command: resolve the catalog with the change-areas resolver (below), or there are no catalog-mandated specialist gates |
| `drive.change_areas_catalog` | Path to the change-area catalog (YAML whose `areas:` map holds area key → `{paths, impliedBy, review: {skills}, postDeploy, …}`) | No catalog: skip the catalog steps and say so in the summary |
| `review.bots` | The logins of the repository's AI reviewers | No AI reviewer is assumed |
| `issue_tracker.team` | Linear only: the prefix its issue keys carry (`ENG` for `ENG-123`), used to recognise the issue a deferral names; on GitHub Issues a key is `#123` | A deferral must still name its issue; any issue key or link counts |

### Policy comes from the base branch, not the change under review

The change under review cannot define the rules it is reviewed against
(Jig module M7). Otherwise a change could weaken an ADR rule, drop a
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

The review helper enforces these boundaries without shell pipelines or
environment assignments:

- Policy commands receive an enumerated environment: the caller's `PATH`
  and `HOME`, the native host variables needed to locate tools on Windows
  (`SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`,
  `USERPROFILE`), `NoDefaultCurrentDirectoryInExePath=1`,
  `JIG_CONSUMER_ROOT=<base-tree>`,
  `JIG_OVERLAY=<base-tree>/.config/jig.yaml`, and `JIG_USER_LAYER=off`.
  The helper derives `PATH` from absolute directories outside the reviewed
  tree, dropping relative and reviewed-tree entries before its first Git or
  GitHub CLI invocation. It stops if no trusted directory remains.
  Its own Git and GitHub CLI calls add only the variables they need to reach
  a remote (SSH agent, proxies, certificate bundles, GitHub CLI configuration
  and tokens, `APPDATA`, `LOCALAPPDATA`); policy commands never receive them.
  The rule check additionally receives `RULES=<base-tree>/<rulesFile>`.
  `WINDOW` and `STRICT` stay unset; where the base branch requires other
  values, run its trusted gate wrapper with the `run` operation below.
  Every policy Bun child starts inside the snapshot with `--no-env-file`
  and the snapshot's `bunfig.toml`, or an empty configuration when that file
  is absent. Its configured preloads finish there before a trusted startup
  helper enters the reviewed tree for a content check. This keeps relative
  preload paths inside the snapshot while retaining the check's normal
  command-line entry point. The shared process runner adds its own Windows
  cancellation registry (`JIG_PROCESS_REGISTRY_DIR`), enforces a deadline of
  60 seconds and reaps descendants; ambient tracing variables are not
  forwarded. A policy command that leaves unfinished descendants fails even
  when its direct process exits successfully.
- One effective file list is stored outside both trees, separated by null
  bytes. Git supplies null-byte-delimited output; no shell splits or unquotes it.
  The helper deduplicates it and rejects line breaks because a configured
  validation plan receives one path per line. Deleted paths remain in the
  list for classification and catalog routing; content checks skip files
  that no longer exist. Every later step reads this same list.

Set up once per review:

1. **Create the trusted snapshot and file list.** Run from the reviewed
   repository. The helper resolves `origin/HEAD`, or asks GitHub for the
   default branch, fetches it, and reads its overlay through the shared
   configuration reader with user and environment configuration disabled.
   It fetches `repository.base_branch`, or the default branch when absent,
   and creates a detached temporary checkout. For a pull request, pass
   `--pr <PR>` to use that pull request's base instead.

   ```sh
   bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" setup
   ```

   With explicit files, append `--files` and the paths as separate quoted
   arguments. Otherwise the list includes all changes since the merge base,
   committed, staged, unstaged and untracked, with both sides of renames:

   ```sh
   bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" setup --files "src/orders/orders.service.ts" "docs/plan.md"
   ```

   Keep the JSON output's `session`, `base`, `baseTree`, `files` and `bunfig`
   values. `<session>` below is the absolute `session` path. Use its one
   `base` value throughout the review. To inspect the fixed file list as a
   JSON array without changing path boundaries:

   ```sh
   bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" files "<session>"
   ```

2. **Resolve policy inside the snapshot.** ADR discovery and configuration
   reads use the trusted snapshot, with the enumerated environment:

   ```sh
   bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" locate "<session>"
   bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" config "<session>" drive.change_areas_catalog
   ```

   Read `rulesFile` from the locator's JSON. A nonzero exit is blocking:
   report the missing or ambiguous policy input and stop. Every configured
   policy value comes from this snapshot. Never read the reviewed tree's
   overlay to select a policy path.

3. **Run policy over the reviewed data.** Pass the base-relative rule-check
   script and rules-file paths. The script comes from the snapshot, while
   its relative file arguments resolve against the reviewed tree. This
   preserves anchored exclusions and checks added files' actual contents:

   ```sh
   bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" check "<session>" "<path to adr-rules-check.ts>" "<rulesFile>"
   ```

   An empty surviving file list succeeds without invoking a check that
   might interpret no arguments as a request to inspect the whole tree.
   For another trusted Bun script, choose `snapshot` for commands that read
   policy or the file list, or `reviewed` for checks that read changed file
   contents. The script path is always relative to the snapshot; extra
   arguments follow it:

   ```sh
   bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" run "<session>" reviewed "<path to contract-check.ts>"
   ```

4. **Clean up at the end, including after a blocked review.** This removes
   the detached worktree and its temporary list, configuration and session:

   ```sh
   bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" cleanup "<session>"
   ```

A policy file the change adds or edits is a proposed policy change: review
its diff as part of the change (a weakened rule or a removed gate is itself a
finding), but do not apply it to this review. A policy file absent on the
base branch means there is no established policy of that kind yet; say so in
the summary.

## Quick start

```text
# Review uncommitted changes (most common)
/jig:review

# Review specific files
/jig:review src/orders/orders.service.ts

# Tier 1 only (fast pattern checks)
/jig:review --tier=1

# Review a plan document
/jig:review docs/plans/checkout-redesign.md

# Full pull request review
/jig:review --pr
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

```sh
bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/../resolve-review-comments/scripts/list-unresolved-threads.ts" <PR>
```

The `--comments` mode of `gh pr view` returns only top-level conversation
comments and omits every inline review thread, including blocking ones.

**Resolve the catalog for every review, not only catalog changes.** The table
above routes tiers; it does not route specialist gates. Those come from the
catalog, so the resolver runs unconditionally: a one-line frontend diff
follows the frontend row to Tier 1 only, and would otherwise skip a
catalog-mandated design-language review, exactly as an infrastructure diff
would skip its infrastructure review.

Resolve the catalog with the session's fixed list and trusted configuration:

```sh
bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" catalog "<session>"
```

The helper prints `catalog_changed` on stderr when the configured catalog
is listed and prints the validation plan's JSON on stdout. A configured
`drive.validation_plan_command` runs inside the snapshot through Bun's
portable shell, with the enumerated environment and one path per line on
stdin. Commands requiring a particular external shell must name that shell
and have it installed; Jig's own procedure needs no Git Bash. Without a
plan command, the sibling change-areas resolver reads the same null-byte-delimited list
with `--no-validation` and resolves `reviewSkills` and `postDeploy` against
the snapshot's catalog. No catalog yields an empty plan and must be
mentioned in the summary.

Any failure is a blocking finding of the catalog's own validation (below),
an unknown field included: a misspelt `review` would otherwise carry no
`review.skills` and drop a mandatory gate in silence. A catalog with fields
only the repository's own wrapper around the resolver (its
[composer](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) knows is resolved through that wrapper,
which the repository names as `drive.validation_plan_command`.

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
of it over `<effective-files>`, as setup step 3 shows, instead of
hand-grepping. Critical violations **block** further progress.

```sh
bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" patterns "<session>"
```

The helper prints example `console.log`, `: any` and `as any` matches with
file and line numbers, skips deleted files, and fails on a read error.

A grep hit is not itself a finding. Read it against the rule's own scope and
the repository's instructions on which standards apply to which kinds of file
before flagging: test files, fixed historical or sentinel values, and one-shot
command-line entry points are commonly out of a rule's scope.

**Every tier: a deferral names a filed issue.** If the diff, its pull request
body or a comment defers scope ("out of scope", "separate issue", "follow-up",
"TODO", "phase 2"), it must name the tracker issue it defers to (its key:
`ENG-123` on Linear, where `issue_tracker.team` names the prefix, or `#123`
on GitHub Issues). An unnamed
deferral is not a deferral but a disappearance: the work it carves out is
never filed, and the gap it leaves ships as if it were closed. Flag every
unnamed deferral as a warning and require either a filed issue or its
removal.

**Every tier: a loosened ratchet goes to a person.** A commit in the range
that carries a `Ratchet-Loosen: <rule>: <reason>` trailer lowers a rule the
repository's ratchet gate holds (the M1 ratchet: a rule may keep its existing
findings but must not gain new ones). List every such trailer in the summary
as a finding for a person to confirm, with the rule and the reason given,
whatever the gates say:

```sh
bun --no-env-file --config="${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "${CLAUDE_SKILL_DIR}/scripts/review.ts" trailers "<session>"
```

**Tier 2, contract validation (mid-size model):** run the repository's own
contract and drift checks for the artifact types present, in parallel. For
example:

- database schema drift: the live schema against the committed schema file;
- generated API description freshness, and any policy on what the API
  surface may expose;
- the published interface surface: an operation the change adds to the
  published contract names its external consumer in the pull request (not
  "future customers"), every request input it declares carries a type and
  the upper bound its kind needs (a maximum length, a pattern or a format
  on a string, a maximum on a number, a maximum item count on an array, a
  closed shape on an object, as
  [M15's *Bounded inputs*](https://github.com/jig-harness/jig/blob/main/modules/M15-contracts-errors/README.md)
  states it; a minimum alone bounds nothing), and its
  declared failure statuses cover what its handler and the error boundary
  can produce; an operation only the repository's own clients need carries
  the internal mark;
- hand-written type mirrors of a schema across a client and server boundary;
- data-isolation filters on queries, in a repository that keeps several
  customers' data in one database;
- when the diff touches documentation: claims whose cited source moved or no
  longer resolves, if the repository checks documentation claims.

Generated-artifact freshness is Jig module M2's practice; use the
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
   `/jig:resolve-review-comments` needs, but nothing here posts *this
   run's* findings to them: there is no handoff from this skill into a pull
   request thread. The repository's AI reviewer (`review.bots`), if it has
   one, runs its own independent review on pushes, on its own cadence and
   coverage. A harness review command that posts inline comments (Claude
   Code's `/code-review --comment`, for one) likewise runs a fresh review of
   the diff and posts *that* review's findings once the pull request is
   Ready, whether a human marked it Ready or `/jig:drive-pr` did after
   its first completed round. Neither replays this run's Tier 1–3 findings.
   Treat the pull request's inline threads and this skill's summary block as
   two independent reviews, not a pipeline. Do **not** post from here.

   A findings panel with no resolved or unresolved state cannot carry the
   outcome-prefixed replies `/jig:resolve-review-comments` requires,
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
   (for example, in Herdr:
   `herdr agent read <target> --source recent-unwrapped --lines <N>`, since
   its default `herdr pane read <pane> --source recent` window is short; in
   tmux: `tmux capture-pane -p -S -<N>`).

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
Jig module M5's `adr-rules.yaml` template; this skill also reads, when
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
before opening a pull request → /jig:review → Tier 1 blocks if critical → Tier 2 blocks on a failing blocking check, other warnings in the PR body → Tier 3 required for db/api
/jig:do-item <issue> → runs the same tiers as its pre-PR code review gate
CI: the repository's ADR rule check, pattern tier only
```
