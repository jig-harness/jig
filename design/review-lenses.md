# Review lenses: design

**What problem this solves.** A
[review lens](../GLOSSARY.md) is one check taught to a reviewer. Jig's
[M7](../modules/M7-pr-lifecycle-review/README.md) specifies how lenses are
held (numbered, additive, comment-only until measured), but ships none: each
repository starts from an empty list and grows its own from its misses
([M8](../modules/M8-learning-loop/README.md)). Until it has, the
[`review`](../plugin/skills/review/SKILL.md) skill's semantic tier checks a
change against the repository's decision records and specialist skills, and
nothing checks it against the rules Jig's own modules state: that no failure
is swallowed (M15), that a changed behaviour comes with a test that would
catch its regression (M14). With this built, `review` runs a small set of
[seed lenses](../GLOSSARY.md), each the review form of one module rule,
on every change whose diff gives it something to check, says why it skipped
the others, and a repository's own reviewer can load the same lenses.

This is the design of [plan.md](plan.md) item 23. Nothing of it is built.

## Why these lenses

Each seed lens enforces a rule a Jig module already states, for the part of
the rule no gate can check. M15's lint flags the default-returning catch,
the discarded error output and the unchecked cast; it cannot tell a fallback
the caller expects from one that hides a fault. A lens owns that judgment.

Jig's rule is to bring in only what working use has validated. Single-concern
reviewers of these kinds (swallowed failures, test gaps, stale comments, type
invariants), run beside a general review, are in wide use in published review
tooling, and Jig's maintainers take that use as the validation the rule
asks for. What is validated is the kind of check, not any text: each lens is
written here, from the module rule it enforces. Whether a lens's findings are right in a given
repository is still measured before it may block (below).

## How it works

### The lens file

Each lens is one Markdown file with frontmatter. The plugin ships the seed
lenses in `plugin/skills/review/lenses/<name>.md`; a repository keeps its own
in the same format, in the directory its configuration names. The file is the
lens contract M7 refers to: `review` reads it, and so can a repository's
[shadow reviewer](../GLOSSARY.md), so a lens is written once.

```markdown
---
id: jig.swallowed-failure
version: 1
rules:
  - https://github.com/jig-harness/jig/blob/main/modules/M15-contracts-errors/README.md#core-pieces   # piece 1
  - ...
lever: ~
trigger:
  paths: ["**/*.{ts,tsx,js,mjs,py,go,rb,rs,java,kt,sh}"]
  exclude: ["**/__tests__/**", "**/*.test.*", "**/fixtures/**"]
  added_lines: ['\bcatch\b', '\bexcept\b', '\.catch\(', ...]
  removed_lines: ['\bthrow\b', '\braise\b', 'return err\b', ...]
evidence: absorbed-failures
---

## Look for
## Not a finding
## Evidence
```

- **`id`** is stable and never reused. Seed lenses carry the `jig.` prefix,
  which a repository's own lens may not use; a repository lens keeps M7's
  `LENS-NNN` numbering. A `jig.` id serves as a seed lens's number.
- **`version`** rises with every edit that changes what the lens reports.
  Measurement counts per `id` and `version`, so a rewritten lens starts a new
  measurement instead of inheriting the old one's precision. A new version
  is recorded in the release notes, so it is never a silent rewrite.
- **`rules`** lists the module rules the lens enforces, one absolute URL to
  each, since the installed plugin holds no module. A seed lens has at least
  one; no rule is listed by two seed lenses.
- **`lever`** is the [lever](../GLOSSARY.md) the lens answers: `~` for a
  seed lens, which [`review-config.yaml`](../modules/M7-pr-lifecycle-review/templates/review-config.yaml)
  already allows as "seeded", and a lever number for a repository lens.
- **`trigger`** says what in the diff makes the lens applicable
  ([Selection](#selection)).
- **`evidence`** names the field every finding of this lens must fill. It
  makes a finding checkable: a person or the
  [arbiter](../plugin/agents/review-arbiter.md) confirms or refutes it by
  reading the code the evidence points at, without redoing the review.
- The body says, in plain language, what to look for, what is **not** a
  finding (the cases the lens would otherwise flag over and over), and how to
  fill the evidence field.

A lens body is complete on its own: everything the reviewer running it
needs is in the file, and its links are for people. It names a
repository's own conventions (its logging functions, its error-code
registry, its test layout) by pointing at the repository's instruction
files, never as a value written into the lens.

A reviewer outside the plugin, such as a shadow reviewer in CI, reads a seed
lens from Jig at a release tag (`plugin/skills/review/lenses/<name>.md` at
`v<version>`) and runs the selection script on its own, which prints its
result as JSON for that purpose.

### The seed lenses

| Lens | Rules | Evidence a finding gives |
|------|-------|--------------------------|
| `jig.swallowed-failure` | M15 piece 1 (never swallow, keep the cause) and piece 3 (branch on type or code, never on message text) | which call's failures the handler absorbs, and where each ends up: a returned value, a log line without its cause, or nothing |
| `jig.test-gap` | M14 pieces 2 (honest doubles), 4 (poll, don't sleep) and 8 (tests come with changes) | an input, and the wrong result that would ship with no test failing; the test files searched for one that already covers it |
| `jig.stale-comment` | M4's rule for comments in code, added by this item | the claim, quoted, and the line it contradicts, quoted; or the historical wording, quoted |
| `jig.type-invariants` | M15 piece 2 (three failure channels) and M15's rule for types, added by this item | an invalid value the type admits, and the line that constructs or accepts it |

What each looks for:

- **Swallowed failure.** A failure turned into a default, an empty result or
  a success; a fallback that hides the fault from the caller and from
  whoever operates the system; a handler broad enough to catch failures it
  was not written for; a wrapper that drops the cause; retries that end
  without a report; work nobody awaits that bypasses the repository's
  detached-work helper; a removed check or `throw` that let a failure
  through; a branch on an error's message text. Not a finding: a shape a
  gate already reported at the same line in this run, a fallback the code
  states as intended while still reporting the failure with its cause, a
  test that asserts the failure.
- **Test gap.** A new branch, failure path or boundary, or a changed
  result, that no test exercises; a test that would still pass if the change were reverted; a
  test that asserts on how the code works (calls to its internals) rather
  than what it does; a double that behaves unlike the real thing; a fixed
  sleep. Not a finding: a change no test could observe (a rename, a moved
  line, formatting), a gap an existing test covers (the lens searches before reporting), a coverage percentage.
- **Stale comment.** A comment whose claim the code contradicts after this
  change (a parameter, a return value, a behaviour, a named symbol, a
  number); wording that tells how the code got its shape ("now", "changed
  to", "fixed") instead of the rule it follows; a TODO the change completes
  but leaves in place; a comment that only restates its line. Not a finding:
  comments the change neither touches nor makes wrong, and wording a
  person might prefer but no rule asks for.
- **Type invariants.** A new or changed type that admits a value the code
  treats as impossible: two fields that must agree, an optional field
  required in one state, a string where a closed set is meant, two booleans
  encoding three states; a construction path that skips validation; an
  expected outcome the caller must branch on, typed so that it cannot tell
  the outcomes apart without the result type's two arms. Not a finding: the
  style of a type's syntax, types the change neither adds nor alters, a
  failure turned into an empty value (that is `jig.swallowed-failure`'s).

The last two need a rule to enforce. Their build steps add it to the module
first: M4 gains *comments state what the code does now* (a comment says what
the code does and why, never restates the line, never narrates how it came
to be, and changes with the code it describes), and M15 gains *types admit
no invalid value* (a value the code treats as impossible cannot be built:
the type rules it out, or its one constructor refuses it). Each gets its
mappings and criteria like any rule.

### Selection

The diff is data from the reviewed tree. `review` writes it once in setup,
from the effective file list, into `<effective-diff>`, a temporary file
outside both trees that setup's cleanup removes with the others. Every
setting that could change what the diff shows is fixed on the command line,
so neither the caller's git configuration nor the change's own attributes
file can hide an edit:

```bash
{
  # the tracked entries of <effective-files>, null-separated, on standard input
  xargs -0 git --literal-pathspecs --attr-source="$VALIDATION_BASE" \
    -c core.quotePath=false \
    diff --no-color --no-ext-diff --no-textconv --text --no-renames \
    --src-prefix=a/ --dst-prefix=b/ -U0 "$VALIDATION_BASE" --
  # then, for each untracked file and for every file under --files
  # (exit 1 means only that the file differs from nothing):
  git -c core.quotePath=false \
    diff --no-index --no-color --no-ext-diff --no-textconv --text \
    --src-prefix=a/ --dst-prefix=b/ -U0 /dev/null "<file>"
} > "<effective-diff>"
```

Setup runs these commands one at a time and checks each one's exit status:
the tracked diff must exit 0, each comparison with nothing 0 or 1. Any other
status, from any of them, discards `<effective-diff>` and stops the review,
so a partial diff never reaches selection.

`--attr-source` (git 2.41 or later; setup checks the version first and
stops, naming the requirement, on an older git) reads attributes from the
base commit, so a clean filter or an encoding the change declares does not
apply. `--literal-pathspecs` keeps
a file named like a pathspec a path. Under `--files`, which has no merge
base, every named file is diffed against nothing, so each of its lines counts
as added, since the request is to review those files as they are; a named
path that does not exist in the reviewed tree stops the review as a usage
error. A file a change deletes is reviewed through the base comparison,
where it counts as wholly removed. The parser reads paths from the `+++ b/` and
`--- a/` lines, which git writes quoted, with C escapes, when a path holds a
special character; it unquotes them, and a path that matches no entry of
the effective file list stops the review.

`plugin/skills/review/scripts/select-lenses.ts` takes the effective file
list and `<effective-diff>` as arguments and runs inside the base snapshot
with the enumerated environment, like every policy command in `review`
([Policy comes from the base branch](../plugin/skills/review/SKILL.md#policy-comes-from-the-base-branch-not-the-change-under-review)).
It reads the seed lenses from the plugin, and the configuration and the
repository's lens directory (`review.lenses.dir`, resolved inside the base
snapshot) from the base snapshot. A lens file the change adds, edits or deletes is a
proposed policy change: `review` reviews its diff and never runs the
proposed version. A lens the base snapshot holds runs in its base version as
usual, whatever the change does to its file; a lens the change adds has no
base version and is reported as `proposed`.

A lens runs when at least one changed file matches its `paths` and none of
its `exclude` globs, and, if it gives `added_lines` or `removed_lines`, when
at least one added or removed line of such a file matches one of those
patterns. Patterns are JavaScript regular expressions, matched case-sensitively
against one line at a time. Selection is an approximation of "this diff
gives the lens something to check" that errs towards running: a lens that
runs with nothing to find reports nothing, while one that is skipped finds
nothing in silence.

A lens id that names no lens (in `off`, `triggers`, `promoted` or `--lens`),
a pattern that is not a valid regular expression, a repository lens with the
`jig.` prefix, and a lens file whose frontmatter does not parse are
configuration errors: `review` stops and names them, rather than letting a
mistyped id do nothing.

For each lens the script prints whether it runs and why: the first path and
line that matched, `no trigger matched`, `off`, or `proposed`. It prints the
same as JSON with `--json`, for a reviewer outside the plugin. The review
summary lists every lens that did not run with its reason. `--lens=<id>`
runs a lens whatever its trigger or `off` says; it names a seed lens or a
lens in the base snapshot, never one the change adds.

### Running

Lenses run in Tier 3, after Tiers 1 and 2, whose findings each lens receives
so it does not report what a gate already did; under `--tier=3` they get
none, and may then report a shape a gate would also flag. Each selected lens
runs as its own reviewer with fresh context, so one lens's conclusion does
not steer another's:

- where the harness has [subagents](../GLOSSARY.md), each lens is one, and
  they run at once;
- otherwise each lens is a fresh non-interactive run of the harness's agent
  command, started inside `<base-tree>` with the enumerated environment and
  with the harness's project settings taken from the base snapshot or
  turned off, never from the reviewed tree: a reviewed tree's instruction
  file or hook would otherwise steer, or run code in, its own review. The
  reviewed files reach it by absolute path, as data;
- where neither is possible, the lenses run in the same session and the
  summary says that they shared a context.

Each gets the lens file, the diff, the files the diff touches and the
repository's instruction files from the base snapshot. Each selected lens
costs one run of the strongest model on the diff, which is why selection
exists. `--quick`, `--tier=1`, `--tier=2` and `--skip-t3` run no lens, and
the summary says so.

Every finding carries the fields `review`'s finding quality bar already
asks for (file and line, severity, confidence, scenario, impact, fix) plus
the lens's `id@version` and its evidence field. A finding keeps the
severity its lens gave it, and gets an effective severity from the lens's
posture (whether its findings may block; every lens starts comment-only):

- a lens that has not been promoted (every lens, until
  [Promotion](#promotion)) caps the effective severity at `WARNING`;
- a finding whose evidence field is empty is effective `INFO` and marked
  unverified. `review` checks only that the field is filled; whether the
  evidence is true is for a person or the arbiter.

Tier 3's line reads `✅ APPROVED`, `⚠️ WARNINGS`, `⏭️ N/A` or `❌ REJECTED`.
`⚠️ WARNINGS` means the only findings left are lens findings of effective
severity `WARNING`; `⏭️ N/A` means no semantic trigger fired and no lens
ran. An effective `INFO` finding is listed and changes no verdict. The
summary gains:

```
Lenses:  2 run, 2 skipped  (jig.swallowed-failure@1: 2 WARNING; jig.test-gap@1: none; jig.stale-comment: no trigger matched; jig.type-invariants: off)
```

The exit criteria change to match: `APPROVED WITH WARNINGS` admits Tier 3
lens warnings as well as Tier 2's, and a promoted lens rejects Tier 3 when it
reports a finding whose effective severity is `CRITICAL`.

`do-item`'s pre-PR gate runs its own tiers rather than calling `review`. It
gains the same lens step, run the same way: it creates a base snapshot, the
effective diff and the enumerated environment as `review`'s setup does, and
runs `select-lenses.ts` and the lens runner from there. Its existing rule
that a change under its small-change threshold skips Tiers 1 to 3 skips the
lenses too. Its Tier 3 line gains `⚠️ WARNINGS` and `⏭️ N/A`, its summary
the `Lenses:` line, and lens warnings go under `## Review Notes` with Tier
2's.

### Configuration

New fields under `review.lenses` in `.config/jig.yaml`, read from the base
branch's copy. Every field is optional; absent, every seed lens runs
unpromoted.

```yaml
review:
  lenses:
    dir: .config/review-lenses        # the repository's own lens files
    off: [jig.type-invariants]        # lenses not to run
    triggers:                         # appended to a lens's own trigger
      jig.swallowed-failure:
        added_lines: ['\bunwrap_or_default\(']
        exclude: ["spec/**"]
```

`triggers` appends to `paths`, `exclude`, `added_lines` and `removed_lines`;
it never replaces a lens's own patterns, so a repository adapts a seed to its
languages and layout without editing it.

### Promotion

A lens may block only once its measured precision (the share of its
findings that were right) clears M7's [precision bar](../GLOSSARY.md), and
the decision is a person's. The record of it goes in the configuration, the
one place a lens's posture for `review` is set (a lens file carries none,
and a shadow reviewer's `review-config.yaml` sets the posture for that
reviewer only):

```yaml
review:
  lenses:
    promotion_bar: { min_true_positive_rate: 0.90, min_sample: 20 }
    promoted:
      jig.swallowed-failure@1:
        measurement: docs/parity/2026-q4.md   # the parity report that cleared the bar
```

`promotion_bar` takes M7's key names and defaults to the values in M7's
`review-config.yaml`. The parity report gains a `MIN_SAMPLE` input, so a
reviewer with fewer findings than `min_sample` is never marked promotable,
however precise. A promotion names a lens version, so a new version of the
lens is unpromoted until it is measured again. The audit's configuration
check requires `measurement` to name a file that exists, which needs the
configuration schema to describe a map whose values are objects with typed
fields; at run time, a promotion whose file is missing on the base branch
leaves the lens unpromoted, and the summary says so.

### Measurement

M8's [parity report](../modules/M8-learning-loop/reference/parity-report/README.md)
takes one row of tallies per reviewer. Each lens version becomes one: the
reviewer column is `<id>@<version>`. The counts come from pull request
review threads, where every finding reaches a terminal state through
[`resolve-review-comments`](../plugin/skills/resolve-review-comments/SKILL.md):

- a reviewer that posts a lens's finding writes the marker in the thread's
  first comment, in this order, so the existing category parser still reads
  the category: `**<severity>** · 🏷️ category: <token> · 🔎 lens: <id>@<version>`;
- a tallying script, `lens-tallies.ts` beside the parity report, lists the
  repository's pull requests merged in a date range, reads each one's
  threads, resolved ones included, with `list-unresolved-threads.ts
  --include-resolved`, takes the lens from the first comment and the
  outcome from the last outcome-prefixed reply by a trusted author
  (`OWNER`, `MEMBER` or `COLLABORATOR`, the rule M8's thread sample already
  applies), and writes one `parity.tsv`
  row per lens version. A first comment counts only when its author is one
  of the reviewer identities the repository configures; a lens marker from
  anyone else is not a finding of that lens;
- `accepted`, `wont-fix` and `deferred` count as true positives (the finding
  was right), `rejected` as a false positive, and `moot`, unresolved threads
  and threads whose replies were cut off by the listing's limit not at all;
- a missed blocker counts against a lens only when the miss is filed as an
  M8 lever whose record names the lens in a `lens` field, which M8's lever
  record gains. Until a repository records that, the column is 0 for lens
  rows: an outside reviewer's finding carries no lens, and guessing which
  lens should have caught it would make the gate's hardest signal a matter
  of opinion.

`resolve-review-comments` today keeps `--include-resolved` off every counting
path; its instructions gain the lens tallies as the one counting use, which
reads only threads that reached a terminal state.

`review` posts nothing to a pull request, so its own runs are not counted.
A repository measures a lens by running the same lens file in its shadow
reviewer, comment-only. Its measurement stands in for `review`'s,
which runs the same lens with different surrounding context; the promotion
record names the measurement, so a person sees which runner produced it.

### Proving a lens

Selection is tested in CI like any script. Whether a lens finds what it
should is not a CI test, because it needs a model run. Each lens therefore
ships with constructed [eval fixtures](../GLOSSARY.md) in
`plugin/skills/review/lenses/fixtures/<name>/`: a diff it must flag and a
diff from its *Not a finding* list it must stay quiet on. They are written
for the lens rather than pinned from a repository's history, so they prove
the lens reads its own instructions, not that it catches a real miss; a
repository's misses become pinned fixtures through M8. Before the lens first
ships, and again for each new version, both are run live once, and the
result is recorded beside them. A lens whose fixtures have not passed live
does not ship.

## Build order

1. **The lens contract and the first lens.** The lens file format; the
   effective diff in `review`'s setup; `select-lenses.ts` with its tests,
   configuration errors included; the Tier 3 runner, its states, the summary
   line and the exit criteria; `--lens` in the arguments; the lens step in
   `do-item`'s gate; `review.lenses` (`dir`, `off`, `triggers`) in
   CONFIGURATION.md and the configuration schema; and
   `jig.swallowed-failure` with its eval fixtures. M7's README replaces "the
   lens catalogue" in *Left out by design* with the seed lenses and the lens
   file as its contract. `review-config.yaml`'s closing note that semantic
   lenses are grown locally, not shipped, changes to name the seed lenses,
   and a lens entry there may reference a lens file (`file:` or a seed
   `id`) instead of restating it. The glossary's *review lens* entry admits
   a seed lens's `jig.` id as its number. The audit is re-evaluated against
   the change. A change note.
2. **`jig.test-gap`**, with its eval fixtures and a link from M14's pieces 2,
   4 and 8 to it.
3. **`jig.stale-comment`**: M4's rule for comments in code, with its mappings
   and criterion, then the lens and its eval fixtures.
4. **`jig.type-invariants`**: M15's rule for types, with its mappings and
   criterion, then the lens and its eval fixtures.
5. **Measurement and promotion.** The `🔎 lens:` marker in the lens contract;
   `lens-tallies.ts` with its tests and its recipe in M8's mappings; the
   `lens` field on M8's lever record; `MIN_SAMPLE` in the parity report; the
   counting use in `resolve-review-comments`'s instructions;
   `promotion_bar` and `promoted` in the configuration, with the schema's
   typed map values; the effective-severity rule for promoted lenses and
   Tier 3 rejection; M11's `promotion-cites-recorded-measurement` criterion
   extended to read `review.lenses.promoted`, and M8's `lenses-additive`
   criterion stating that a seed lens's `jig.` id and `lever: ~` satisfy it
   and that a recorded new version is not a silent rewrite.

Steps 2 to 4 each need only step 1; step 5 needs step 1 and lets any lens
shipped by then be promoted.

## Left out

- **Dropping findings below a confidence threshold.** `review` reports every
  finding and lets the verdict filter; M8 cannot measure the precision of
  findings that were never reported.
- **A lens for declared failure statuses.** M15 names that rule a review lens
  until a checker exists, and `review`'s Tier 2 already checks it.
- **Seed lenses for the other modules.** Their rules are checked by gates
  and catalog-selected reviews already; a lens follows only for a rule whose
  judgment no gate can make.

## Review

Critiqued on 2026-10-21 in two rounds by reviewers with fresh context
(subagents that did not write it), the second against commit `695e68b`.
