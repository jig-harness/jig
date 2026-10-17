# M2 — Generated-artifact freshness

**What problem this solves.** Repos accumulate files derived from other files:
API specs from route definitions, ORM types from migrations, doc indexes from
doc trees, dependency notices from lockfiles — and prose that states countable
facts (`we have 120 skills`). Each derived copy silently rots the moment its
source changes, and both humans and agents then act on the stale copy. This
module makes staleness mechanically impossible — or at least mechanically
loud.

## Invariant

> Nothing derived is trusted at rest. A derived file is either (a) not
> committed at all, (b) not committed but its would-be content is CI-checked
> against reality, or (c) committed with the full freshness triad: a
> regenerate script, a CI drift check that fails when stale, and a commit-time
> auto-regenerate-and-stage hook.
>
> Every committed derived file is declared once, in one inventory: its
> outputs, its source, its regenerate command and its check. CI runs every
> declared check through one generic runner, never one hand-added step per
> generator, so a generator cannot ship without its check.
>
> Derivation runs one way: an artifact that disagrees with its source is
> regenerated, never edited to match. A generator reaches every input that
> exists, and a regeneration after a merge reaches the protected branch
> through a pull request, as every other change does.
>
> A number in prose that constrains its content stays; one that tallies an
> adjacent list is dropped, or declared as a fact and checked against its
> source on every run.

## The decision ladder: drop > check > commit

Ordered by preference — materializing a derived file at rest is a liability
(it can drift *and* it merge-conflicts when parallel branches both regenerate
it), so:

1. **Drop** — generate at build/consume time; never commit the artifact.
   Choose when no consumer needs the file in the repo.
2. **CI-check without committing** — for *derivable facts stated in prose*
   (counts, rosters, path references in instruction files): a CI job recomputes
   the fact and fails on mismatch, but no generated file is committed.
   Committed generated includes are the tempting alternative, and they fail:
   every parallel branch that touches their inputs regenerates them, so every
   merge conflicts on the generated file.
3. **Commit + triad** — when consumers genuinely need the artifact at rest
   (published specs, generated types consumed by builds): regenerate script +
   drift gate in CI + auto-stage twin in the pre-commit hook, so local commits
   go out fresh and CI catches everything else.

For schema-like artifacts, the strongest drift check is **ephemeral replay**:
spin a throwaway database/container, replay the source of truth (migrations)
from scratch, dump, normalize, and compare — testing the *whole chain*, not
just file timestamps.

## One version source

A toolchain version (the runtime, the compiler, the package manager a
repository builds and tests with) is a derived fact with many copies. It is
declared once, in the file the developers' version manager reads, and then
repeated wherever something installs the tool on its own: a CI setup step, a
container build argument, a package-manager field, a type package that
tracks the runtime. Each copy is a [pin site](../../GLOSSARY.md), and pin
sites drift the way every derived copy does: one is left out and floats to
the tool's latest release, which changes on the day the tool releases; one
is missed by an upgrade and stays a version behind. Code then runs under one
version in CI, another in the container and a third on a laptop, and the
difference shows up as a failure nobody can reproduce.

The rule is rung 2 of the ladder applied to a version: one file is the
source, every other pin site is gated to equal it, and nothing is generated.
A declaration names, per tool, the source and every pin site with how to
read each; a gate fails a pin that differs, a site whose pin is gone, and a
setup step that names no version at all. A pin that differs on purpose, such
as the [runtime canary](../M14-testing-strategy/README.md) that runs the
suites on the tool's next release, is registered as an exception with a
reason, and the exception prunes itself: one that excuses nothing (its value
is the source's now, or no pin holds it) is a finding, as
[M1](../M1-gates-enforcement-ladder/README.md) asks of every exception.
Version ranges (`engines`, a minimum in a project file) are not pins and
stay out: a range stays true across an upgrade, and the install checks it.
[`reference/toolchain-pins/`](reference/toolchain-pins/) is the gate; the
sites per ecosystem are in [mappings](mappings.md#toolchain-pin-sites). An
upgrade then changes the source and lets the gate list every site to
follow; `upgrade-deps`
([ROADMAP item 3](../../ROADMAP.md#3-the-kickoff-family)) is planned as the
runnable form of that upgrade.

## The inventory and the one runner

A triad per derived file is not enough on its own: each triad's drift check
protects the file only while CI runs it, and when that wiring is one
hand-added step per generator, the next generator ships with a check nobody
wired, green until its artifact rots. So the declaration and the wiring are
one thing, the [generated-file inventory](../../GLOSSARY.md):

- Every derived file is **declared once**, with its `outputs` (the committed
  files), its `source` (globs of the files whose change calls for a
  regeneration), the `command` that regenerates it and the `check` that
  fails when it is stale.
- CI runs every declared check through **one generic runner**
  ([`reference/inventory/`](reference/inventory/)), the only CI step the
  practice needs. A new generator adds an entry, never a workflow step; an
  entry without a check does not parse.
- The runner reports every check's result, not only the first failure, and
  fails closed on an inventory it cannot read or a check that cannot start.
- The inventory validates what it can: each output is a file declared once,
  each source resolves to a repository file.

The inventory is a standalone file
([`templates/generated-files.yaml`](templates/generated-files.yaml)) or, in a
repository with a [change-area catalog](../M3-change-area-catalog/), the
`generated:` entries of the areas that own the files, which the runner reads
in the same format. Then the catalog couples each artifact to its area, an
area on the shallow [validation profile](../../GLOSSARY.md) carries this
module's freshness gate without escalating to full code validation, and the
regenerate command lives in one place rather than in a hook, a CI step and a
paragraph of prose. Jig's own derived files are declared that way, in its
catalog, and `bun run gates` runs their checks through the runner.

## Regeneration after merge goes through a pull request

Some derived files are regenerated after the merge rather than demanded
fresh on every pull request: a derivation too heavy to wait for on every
change, a reference document the merge need not block on. Such a file has
no required drift check on pull requests, since that check would fail every
pull request that changes its inputs and block the merge the regeneration
waits for; the run after the merge is how it stays fresh. Every other
derived file keeps its required check, and for those, regeneration after
merge is the backstop the per-change check cannot be: two pull requests
each fresh on their own are stale together once both have merged, because
each regenerated against a branch without the other, and only a run after
the merge sees the combined state.

The regenerated commit is a change like any other, and it reaches the
protected branch the way every change does: **through a pull request that
passes the required checks and that a person merges**, since the merge is a
human act ([M7](../M7-pr-lifecycle-review/README.md)).

- **A direct push cannot, where a required check runs only on pull
  requests.** Required checks are evaluated per commit, and a check that
  runs only on pull requests never runs for a commit pushed straight to the
  branch, so a branch that admits a change only with that check green
  refuses the push every time. That is not a race, and no retry helps. The
  other design, a branch rule that names one automation as the actor
  allowed past it, admits the push and runs the checks on it afterwards;
  that actor must then be the narrowest thing the platform can name, with a
  credential minted per run, and the module's reference design remains the
  pull request.
- **One pull request per generator, on a fixed branch.** Each run pushes
  the fresh content to that branch, opens the pull request if none is open,
  and returns: it neither merges nor waits for the checks. A pull request
  that went stale while open is overwritten by the next run; one stuck on a
  real failure is updated, never duplicated. The branch is overwritten or
  deleted only while every commit on it is the generator's own (authored and
  committed by its bot, so an amended commit is a person's), and the push
  that overwrites or deletes it is leased to the tip the run inspected, so a
  commit a person added to it is never destroyed. A [concurrency group](../../GLOSSARY.md) on the job serializes
  the runs of one generator without cancelling one in progress.
- **No commit carries a CI-skip marker.** The branch commit carries none of
  the platform's skip instructions, or the pull request's checks would not
  run on it, and the publish step refuses one before any work. The merge
  commit carries none either: such a marker suppresses every workflow on the
  push, integration checks and downstream generators as well as this one.
  Recursion is prevented instead by the trigger, which lists the generator's
  inputs and never its outputs, and by the no-change exit below: a run on
  the merged output regenerates identical content and opens nothing.
- **A path-filtered trigger has a limit.** A platform that evaluates the
  filter against only part of a large push (GitHub Actions: the first 3,000
  changed files) can leave the workflow unstarted after a very large merge.
  A manual run from the integration branch is the recovery.
- **A credential of its own.** The identity that pushes the branch and
  opens the pull request is not the ambient token: it is minted per run with
  write to contents and pull requests and nothing else, and its absence
  fails the run before any work.
- **Only from the integration branch.** A manual run started from another
  branch or tag does nothing, and the pull request's base is the integration
  branch as configured, never the ref the run started from: otherwise an
  unmerged generator runs with the publishing credential.
- **Nothing changed, nothing opened**, and a pull request an earlier run
  left open is closed: what it carries is no longer what the generator
  produces.

This is the "every push to the integration branch" row of M13's
[placement rule](../M13-pipeline-economy/README.md#6-place): an artifact
with a required drift check keeps it on every pull request, and the run
after the merge is its backstop. The actions the workflow uses are pinned to immutable revisions
([M1](../M1-gates-enforcement-ladder/README.md), third-party automation
integrity), which M13's
[workflow-convention lint](../M13-pipeline-economy/reference/workflow-conventions/README.md#pinned-uses)
checks. [`templates/regenerate-after-merge.yml`](templates/regenerate-after-merge.yml)
is the GitHub Actions skeleton;
[`mappings.md`](mappings.md#regeneration-after-merge-through-a-pull-request)
gives the steps for other providers.

## Generators reach every input

A freshness check proves one thing: the artifact equals what the generator
writes. It cannot see an input the generator never reads. A route the
application mounts but the spec generator does not stub, a migration outside
the replay's list, a module a roster omits: each is absent from the
artifact, the artifact is fresh, and nothing fails. So **every generator
that selects its inputs by a list it maintains has a check that the set it
reads equals the set that exists**, enumerated from where the inputs live,
with both directions reported: an input unreached, and a listed input that
no longer exists. A generator that walks its inputs reaches them by
construction and needs none.
[`reference/generator-coverage/`](reference/generator-coverage/) compares
the two enumerations.

## Derivation runs one way

When a contract artifact (an API description, a schema file, generated
types) disagrees with its source, **the artifact is regenerated, never
edited to match**. A constraint the artifact needs that the source cannot
express is added to the source layer, which must be able to emit everything
the artifact enforces; otherwise the next regeneration drops the hand-made
part. In a chain of derived files, each link has its own check with its own
fresh output, since a check over the ends of the chain cannot say which link
went stale. A structured artifact is compared as the data it encodes, not as
bytes: a formatter's reflow or a key sort is not drift, and a byte comparison
that reports it on every run teaches the team to regenerate without reading
the diff, where real drift then hides. Whatever normalization the comparison
needs applies to both sides through one function: applied to one side only,
every later fix to it looks like drift of every committed artifact. And
every derived schema comes from one source: a second generator from the same
source is fine, a second artifact maintained by hand beside the generated
one is not. [`reference/compare-as-data/`](reference/compare-as-data/)
compares two copies as parsed data and names each difference by its path.

## Which numbers in prose may stay

A number in prose either constrains its content or describes it, and only
the second is a derived file. A number that **constrains** (a limit, a
budget, a retry count, a threshold: `≤ 8000 chars`, `3 retries`) is part
of what the text means and stays. A number that
[**tallies**](../../GLOSSARY.md) an adjacent list (`the 6 passes`,
`120 skills`, a count beside the list it counts) is a cache of that list
written by hand: it drifts the moment the list changes, it conflicts when
two branches change the list, and it tells the reader nothing the list does
not. The test is one question: does the number constrain the content, or
describe it?

A tally is dropped, letting the list speak, or it earns its place and is
**registered**: declared once in a [facts registry](../../GLOSSARY.md) with
its source (globs over the repository's files, or a command) and the
phrasings a stated copy may take, and re-derived on every run by a check
that commits nothing and fails when a stated copy disagrees
([`reference/prose-facts/`](reference/prose-facts/)). The registry flags
drift, never presence: a fact nobody states has nothing to check.

The exact check cannot see a tally nobody registered. An advisory **presence
lint** over all prose finds a number that reads as one (a cardinal before a
noun the repository counts), judged by shape, and exempts a constraint in
its own clause, a label, an identifier, code, a registered copy and a line
carrying the [measured marker](../../GLOSSARY.md) `<!-- measured -->`. It is
the one carve-out from "flag drift, not presence": it never blocks, and a
finding is a prompt to drop, register or mark. The universal instruction
file states the rule
([M0's skeleton](../M0-instruction-architecture/templates/AGENTS-skeleton.md))
so a reviewer applies it where the lint's shape test cannot.

## Maturity levels

- **Lite** — inventory exists: every derived file in the repo is listed
  once with its regenerate command; hand-editing them is documented as
  forbidden.
- **Standard** — every committed derived file has the full triad; each
  generator that selects its inputs by a list has a coverage check;
  structured artifacts are compared as parsed data; at least prose
  path-references in instruction files are checked to exist; the
  instruction file states which numbers in prose may stay; every toolchain
  version pin equals its one declared source, and a check in CI fails one
  that differs.
- **Strict** — derivable prose facts are declared in a registry and
  CI-checked (commit-nothing);
  schema-like artifacts use ephemeral replay; every derived file is
  declared with its outputs, its source, its regenerate command and its
  check, and every declared check runs through one generic runner in CI,
  with no per-generator step; a regeneration after a merge goes through a
  pull request.

## Adoption steps

1. Declare every derived file in the repository once, with its outputs, its
   source, its regenerate command and its check, in one inventory
   ([`templates/generated-files.yaml`](templates/generated-files.yaml), or
   the change-area catalog's `generated:` entries), and state that derived
   files are never edited by hand; give each derived file a generated-file
   header naming its regenerate command. This is **Lite**.
2. For each derived file, walk the ladder: drop it if no consumer needs it at
   rest; otherwise give it the full triad
   ([`reference/triad/`](reference/triad/)); give each generator that keeps
   a list of its inputs a coverage check
   ([`reference/generator-coverage/`](reference/generator-coverage/)) and
   compare each structured artifact as data
   ([`reference/compare-as-data/`](reference/compare-as-data/)). Check the
   paths that instruction files reference with
   [`reference/prose-facts/check-referenced-paths.ts`](reference/prose-facts/check-referenced-paths.ts);
   a path that lives in another repository is not this one's to check, so
   name that repository with it, as a link to the file there (a URL is never
   checked) or with the repository as a placeholder prefix
   (`<other-repo>/scripts/update.sh`; a placeholder is never checked), rather
   than moving the text out of the instruction file. State in the
   instruction file that a number which tallies a list is
   dropped or registered, and one that constrains stays. Declare each toolchain version's source and
   pin sites and run
   [`reference/toolchain-pins/`](reference/toolchain-pins/) on every change.
   This is **Standard**.
3. Declare the facts prose states in a registry and check them with
   [`reference/prose-facts/check-registered-facts.ts`](reference/prose-facts/check-registered-facts.ts),
   with the tally lint beside it advisory
   ([`lint-derivable-counts.ts`](reference/prose-facts/lint-derivable-counts.ts)),
   replay schema-like artifacts from scratch
   ([`reference/ephemeral-replay/`](reference/ephemeral-replay/)), and run
   every declared check through the one runner
   ([`reference/inventory/`](reference/inventory/)) as the only generated-file
   step in CI, and publish any regeneration after a merge through a pull
   request
   ([`templates/regenerate-after-merge.yml`](templates/regenerate-after-merge.yml)).
   This is **Strict**.

## Status

What this module provides:

- [`reference/triad/`](reference/triad/) — a worked freshness triad: a
  deterministic index generator, its drift check and a fixture, with the hook
  and CI wiring.
- [`reference/prose-facts/`](reference/prose-facts/) — the commit-nothing
  checks: a facts registry checked exactly, the one-fact count check, the
  referenced-paths check and the advisory lint over unchecked tallies, with
  the constraint-versus-tally rule, fixtures for each outcome and the
  self-tests of the registry check and the lint beside them.
- [`reference/ephemeral-replay/`](reference/ephemeral-replay/) — a schema
  drift check that replays migrations into a throwaway Postgres container
  with docker, plus the normalization and operational lessons.
- [`reference/toolchain-pins/`](reference/toolchain-pins/) — the one
  version source: a gate that reads a declaration of each tool's source and
  pin sites and fails a pin that differs, with fixtures and a self-test; Jig
  runs it on its own pins (`bun run pins`).
- [`reference/inventory/`](reference/inventory/) — the generated-file
  inventory's format and the generic runner that runs every declared check,
  with fixtures for each outcome and its self-test beside it.
- [`reference/generator-coverage/`](reference/generator-coverage/) — the
  check that the inputs a generator reads are the inputs that exist, with
  fixtures and its self-test beside it.
- [`reference/compare-as-data/`](reference/compare-as-data/) — the
  comparison of a structured artifact with its fresh output as parsed data,
  each difference named by its path, with fixtures and its self-test beside
  it.
- [`templates/generated-files.yaml`](templates/generated-files.yaml) — a
  copyable inventory starter.
- [`templates/regenerate-after-merge.yml`](templates/regenerate-after-merge.yml)
  — the GitHub Actions skeleton that regenerates after a merge and
  publishes through a pull request a person merges.
- [`mappings.md`](mappings.md) (CI providers, hook managers, container and
  database variants, toolchain pin sites) and the module's [maturity criteria](../../plugin/skills/audit/criteria/M2-generated-artifact-freshness.yaml).

The self-tests for the triad, the one-fact count and referenced-paths
checks and the ephemeral-replay reference are in
[`scripts/freshness.test.ts`](../../scripts/freshness.test.ts); the
toolchain-pins gate's is beside it. The
[`/jig:fix-ci`](../../plugin/skills/fix-ci/SKILL.md) skill uses this
module's vocabulary when a drift check fails: it finds the regenerate command
beside the check and runs it.

Deliberately left out: further triad instances (error-code catalogs, seed
data), because they would add domain values without adding mechanism — the
worked index example carries the whole pattern. The registry practice an
error-code catalog is generated from (one registry, every copy generated, no
code minted elsewhere) is [M15's](../M15-contracts-errors/README.md), with
neutral values.

Future: a check that every file whose header names a generator is declared
in the inventory, so an undeclared derived file is found by its own marker;
promoting the tally lint from advisory to blocking, once a repository has run
it blocking without teaching its team to add the measured marker by reflex;
deciding whether the regeneration criterion admits the named-actor variant
(a branch rule that lets one automation push a regenerated commit whose
checks then run on the push) or keeps asking for the pull request.
