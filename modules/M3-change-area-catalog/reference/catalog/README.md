# Change-area catalog — schema, resolver, projections

This is the specification behind the module [invariant](../../README.md): one
validated catalog, many generated projections. The plugin's
[`change-areas` skill](../../../../plugin/skills/change-areas/README.md)
implements it. A repository may implement it in another language instead;
this file is what any implementation must do. The worked data file is
[`catalog.example.yaml`](catalog.example.yaml).

## Entry schema

The catalog is one YAML file with these top-level fields:

| Field | Req? | Meaning |
|-------|------|---------|
| `areas` | required | the areas, keyed by kebab-case area id (`^[a-z0-9]+(-[a-z0-9]+)*$`) |
| `vocabularies` | optional | the values the open fields may take in this repository, each a non-empty list: `category`, `deployTier`, `agent`, `flags` (tracker flags), `envs` (post-deploy environments) and `profile`; a field without one takes any non-empty text |
| `profiles` | optional | the [validation profiles](../../../../GLOSSARY.md), shallowest first: each name maps to `{ localChecks: [..], verificationChecks: [..], notes? }`, and the last is the deepest. It names the profiles, so `vocabularies.profile` is not declared beside it |

Each area:

| Field | Req? | Meaning |
|-------|------|---------|
| `title` | required | human-readable name |
| `category` | required | grouping tag only; **never** a build/deploy lane |
| `paths` | required | globs that *define membership* — the vocabulary consumers reference (≥1) |
| `workspace` | required | owning workspace dir(s) (`apps/*`, `packages/*`); empty for path-only areas |
| `impliedBy` | required | area-id references: "a change to any listed area also implies this one" (may be empty) |
| `deployTier` | required | which deploy lane applies (`none` for an area that does not deploy) |
| `notes` | optional | load-bearing semantics kept next to the data |
| `review` | optional | `{ skills: [..] (≥1), notes? }` — mandatory review skills for this area |
| `postDeploy` | optional | `[{ action, when, envs: [..] (≥1), notes? }]` — post-deploy operational steps |
| `tracker` | optional | `{ labels?: [..], flags?: [..] }` — tracker labels and flags to derive, whichever tracker the repository uses; `linear` is its older spelling, and an area declares one of the two |
| `labels` | optional | the area's own labels, a list of text, for tooling that reads them |
| `agent` | optional | owning-agent label |
| `validation` | optional | `{ profile?, ownTests?, notes? }`, plus the fields a [composer](../../../../GLOSSARY.md) declares — `profile` names one of `profiles` (absent: the deepest), and `ownTests` is the area's own test command; see [§ Agent gate depth](#agent-gate-depth-validation) |
| `generated` | optional | a list of `{ outputs: [..] (≥1), source: [..] (globs, ≥1), command: "<regenerate command>", check: "<freshness check>", notes? }` — the derived files this area owns, in [M2's inventory format](../../../M2-generated-artifact-freshness/reference/inventory/README.md); see [§ Generated-output coupling](#generated-output-coupling-generated) |

Reserved-but-loosely-typed blocks (`ci`, `deploy`, `scaffolding`, `owner`) let
later consumers attach their own projection without a schema break — leave them
out until their consumer exists.

## Schema-level validation

Enforced field by field, every problem reported at once with the area and
field at fault:

- Area ids **and** every `impliedBy` reference match the kebab-case pattern;
  a profile name is kebab-case and starts with a letter (a name made of
  digits only would be reordered by a parser's map, and declared order is
  what says which profile is deepest).
- Unknown fields are rejected at every level: the top level, each area, each
  nested block and each `generated` entry (catches typos like `reviews:`). A
  repository whose own tooling reads more fields declares them in its
  composer, each a boolean, text, a list of text or one of a closed set of
  values, on areas or on their `validation` block; a composer cannot
  redeclare a built-in field.
- `category`, `deployTier`, `agent`, tracker `flags`, `postDeploy[].envs`
  and `validation.profile` take a value from the catalog's own
  `vocabularies` (profile names from `profiles` when it is declared), and any
  non-empty text when the catalog declares none. The lists are the
  repository's; the schema fixes none.
- `paths` ≥1 glob, each one that compiles; `review.skills` ≥1;
  `postDeploy[]` each carry ≥1 `envs`; each profile lists `localChecks` and
  `verificationChecks`; each `generated[]` entry carries ≥1 `outputs`, each
  a literal repository-relative file path (no glob or shell character), ≥1
  `source` glob, a non-empty `command` and a non-empty `check` — an empty
  `command` passes every filesystem-level check below while leaving nothing
  to run the freshness regeneration, and an entry without a `check` is a
  generator CI cannot run.
- A key repeated in the file (two areas with one id) is an error, not a
  silent last-one-wins.

Schema validation deliberately does **not** check referential integrity or
cycles — a schema-valid catalog may still have a dangling `impliedBy` ref. That
is the graph checker's job.

## Graph validation

Run these after schema validation:

1. **Referential integrity** — every `impliedBy` ref names an existing area.
2. **No self-implication** — `ref != key`.
3. **No cycles** — a depth-first traversal with visiting/done coloring over
   the directed `impliedBy` relation. A cycle is a modeling error: the closure
   would silently glue its members together forever.
4. **Workspace exists** — every declared `workspace` dir exists on disk
   (catches renamed/removed workspaces), written as git lists paths
   (`apps/web`, not `./apps/web` or `apps/web/`), since it is compared with
   git's paths.
5. **Workspace covered by glob** — every file under each `workspace` dir is
   matched by the area's own `paths`, and an empty workspace by a glob that
   would match a plainly named file in it (`apps/**` covers `apps/web`): a
   name of letters, digits, `_`, `-` and `.` that neither starts nor ends
   with `.` and is not a Windows device name (`CON`, `nul.txt`) before its
   first `.`, which git lists on every platform, so a glob that reaches it
   only through a dotfile or a device name does not count. Another area's
   glob does not discharge this: a change it matches never seeds the owning
   area, so that area's checks and reviews never run.
6. **Coverage** — every workspace on disk (`apps/*`, `packages/*`), or every
   file, belongs to some area, so a new, unmapped workspace fails CI in the
   same PR that adds it instead of silently skipping all its gates. Which
   directories or files must be covered is the repository's policy, so a
   composer holds it (the skill exports `uncoveredFiles` for it). Brownfield
   adopters grandfather existing gaps in this check rather than blocking on
   day one — see [§ Grandfathering catalog coverage](#grandfathering-catalog-coverage).
7. **Generated source exists** — each `generated[].source` glob, expanded
   in full, matches at least one file of the repository (tracked, or
   untracked but not ignored), and every file it matches belongs to some
   area's `paths`. A literal-prefix check (before the first wildcard) is not
   enough: a typo further inside the pattern (`src/**/rouets/*.ts`) leaves
   the prefix resolving while the full glob matches nothing, silently ceasing
   to fire the coupling it was meant to declare. A wildcard-leading pattern
   (`**/*.proto` for a repository-wide generator) needs no special case:
   the full-glob match already proves whether it has real sources — see
   [§ Generated-output coupling](#generated-output-coupling-generated).
8. **Generated outputs owned** — each `generated[].outputs` path is a file,
   is declared by exactly one entry in the whole catalog, and is matched by
   its own area's `paths`, so a hand-edit to the output seeds the area whose
   check covers it rather than no area, or two areas running two generators
   over one file.

## The resolver

A pure function of `(changed file paths, catalog)`, kept separate from any git
plumbing so it is unit-testable:

1. **Seed match** — an area is seeded if *any* changed file matches *any* of
   its seed globs: its `paths`, then the `source` globs of its `generated`
   entries. Membership is multi-valued: one file can seed several areas.
2. **Implied closure** — forward transitive closure over `impliedBy`. Fixpoint
   loop: repeatedly add any area `K` whose `impliedBy` lists an
   already-included area, until the set stops growing.
3. The resolved set is `closure(seed(files))`; the union of its areas'
   implications is what the projections consume.

**One relation, both shapes.** The edge is always read "X is `impliedBy` Y ⇒ a
change to Y adds X." *Fan-out* (one shared library → every app) is written by
each app listing the library in *its* `impliedBy`. *Fan-in* (many sources → one
aggregator) is written by the aggregator listing many areas in *its own*
`impliedBy`. The closure walks the same direction for both — do not add a
reverse relation.

The git layer that feeds the resolver picks the diff per CI event: a pull
request's base…HEAD, a push's every commit (from the push's before commit;
its tip alone only when there is none, as for a push that created its
branch), a dispatched run's every commit since the last verified one, and for a merge commit each parent's own files
too (a merge's first-parent diff can show only documentation while the code
arrived through the other parent). Keep it injectable so the pure resolver
stays testable, and fail closed: a diff that cannot be computed is an error,
never an empty change.

## Seeds vs. closure — which side each projection reads

The resolver produces two outputs on the way to `closure(seed(files))`, and
they answer different questions:

- **Seeds** — the areas *directly* matched by a changed file's seed globs.
  Answers *"what did this change touch?"* Precise: a file that seeds an area
  really did land in it, or in the source of a generator it owns.
- **Closure** — seeds plus everything the forward `impliedBy` traversal adds.
  Answers *"what are the consequences?"* Broad by design (see "conservative
  over-trigger" in the module README's design rules); a file several
  `impliedBy` hops away can land an area in the closure without ever matching
  one of its globs.

Every projection must state, explicitly, which side it reads:

| Projection | Reads | Why |
|---|---|---|
| Deploy tier / post-deploy actions | closure | consequences — a rebuild several hops upstream is cheap to over-trigger and expensive to miss |
| Mandatory reviews (`review.skills`) | closure | an under-triggered review is a missed defect and an extra one costs one invocation: a `core-lib` change whose closure reaches `api-service` must request `api-service`'s review too, or the dependent ships unreviewed |
| Per-event CI outputs | both, as two outputs per area | a job gated on the closure output runs for its dependencies' changes; a job that stands in for its own path filter gates on the seed output |
| Tracker labels and flags (`tracker.labels`, `tracker.flags`) | seeds | accuracy — a label or flag is a lasting claim on the issue record, so an over-derived one is a lasting false statement |
| `validation:` (agent gate depth) | seeds (see [§ Agent gate depth](#agent-gate-depth-validation)) | an agent needs the depth of what it touched: a docs edit that implies a downstream service keeps the docs' depth |
| `generated:` (freshness coupling) | seeds, a `generated[].source` match included | the generator to run is the one whose source changed, even where that source lies under another area's `paths` |

**Reviews fail toward coverage; labels and flags fail toward accuracy.** They
need opposite defaults, so a projection that reads the wrong side fails
silently in the wrong direction.

**A flag that must fire for a change goes on an area that change seeds.**
Flags read the seeds, so a flag on an area the change reaches only through
the closure never fires. Give the real trigger an area of its own whose
`paths` cover exactly the trigger files (areas may overlap), and put the
flag there. When the trigger cannot be written as a path glob (it depends on
imports or file content, not location), that analysis belongs in the git
layer that feeds the resolver, which can add synthetic changed paths the
narrow area matches; the resolver itself stays path-based.

**A closure-read review can fire for a change that does not need it, and no
catalog edit removes that.** There is one closure per catalog, and every
closure-reading projection sees the same edges. In the worked catalog,
`api-service.impliedBy` lists `ci-infra` so that the service's deploy and
post-deploy actions follow a CI change; the same edge requests
`api-service`'s `api-review` for a CI-workflow edit with no contract in it.
Narrowing the edge would silence the review and also drop the deploy
trigger the edge exists for, and a narrower area does not help, since the
closure still reaches it through the shared edge. Accept the redundant
review: it costs one invocation, a missed one costs a defect. A repository
that needs review precision decides applicability outside the `impliedBy`
graph, in the review itself.

## Projections (generated)

Each projection is a pure function of the catalog (and, for the dynamic ones,
a resolution). Every committed projection carries a freshness gate (see
[M2](../../../M2-generated-artifact-freshness/)): regenerate in CI and fail on
a non-empty diff. The skill's format for each is in brackets.

| Projection | Kind | Output |
|-----------|------|--------|
| CI path-filter | static | per area: its seed globs ∪ those of every area that transitively implies it — a native CI `paths:` filter that matches exactly when the resolver calls the area affected (`dorny`) |
| Per-event area flags | dynamic | for the CI run's changed files, `key=true\|false` per area for the closure, then `key-seed=true\|false` per area for the seeds; a composer appends its own lines, such as a `code=true\|false` aggregate (`gha`) |
| Review-gate table | static | Markdown table: area → its trigger paths, its seed globs ∪ those of every area that transitively implies it (the CI path-filter's set) → its `review.skills`, so a change that reaches the area through the closure requests the same skills (`review-table`) |
| Component directory | static | Markdown: apps / packages / infra grouped by `workspace`, with deploy tier + owning agent |
| Post-deploy checklist | dynamic | Markdown checklist of `postDeploy` actions for the areas in the closure (`checklist`) |
| Tracker labels and flags | dynamic | the union of `tracker.labels` and of `tracker.flags` over the seed areas |
| Agent gate depth | dynamic | the validation plan the seeds select — see [§ Agent gate depth](#agent-gate-depth-validation) |
| JSON resolution | dynamic | `{ changedFiles, seedAreas, areas, flags, postDeploy, review, reviewSkills, linear, validation, generated }` for other tooling: `flags` is the closure's per-area flags as an object, `review` and `reviewSkills` the closure's review skills by area and once each, `linear` the tracker labels and flags (the key keeps its established name), `validation` the plan and `generated` the seed areas' generators (`json`) |

## Agent gate depth (`validation:`)

CI job selection isn't the only consumer worth generating a projection for.
`validation:` answers a different question: what must a **coding agent** run
before commit and push? It reads *seeds*, not the closure (see
[§ Seeds vs. closure](#seeds-vs-closure--which-side-each-projection-reads)) —
an agent needs to know what it touched, not the whole consequence graph.

The catalog declares its profiles under `profiles:`, shallowest first, each
with its `localChecks` (run before commit, in order) and
`verificationChecks` (run to verify the committed tree: before a push, in
CI, after a review fix). The last is the deepest, and lists at least one
check: it is the fail-closed fallback, so an empty one would plan nothing
for the change the catalog knows least about. `deep` and `shallow` are
the worked example's names, not fixed ones. The plan:

1. Each seed area selects its `validation.profile`. The plan is the union of
   the selected profiles' checks, in declared order, each once.
2. Each seed area's generator `command`s run before the local checks (a
   regenerated file is formatted, tested and built in its fresh state), and
   its `check`s after the verification checks.
3. Each seed area's `validation.ownTests` joins both lists: the area's own
   suite serves before commit and in verification alike.
4. The plan is a minimum: the repository's hooks and its required CI still
   run.

The rules below were learned from real misses:

- **A file matching no area fails closed to the deepest profile.** Adding
  coverage is how a change gets *cheaper* to validate (a narrower, correctly
  scoped gate set); leaving a path uncovered is safe but expensive (it runs
  the deepest gate set by default). Under-validating is the only unsafe
  direction.
- **A seeded area with no `validation` block, or one missing `profile`, also
  gets the deepest profile** — the same fail-closed default as an unmatched
  file, for the same reason. The block opts *in* to a shallower profile,
  never out of being counted: `web-app`, `core-lib`, and `ci-infra` in the
  worked example all omit `validation` and each run the deepest profile.
- **"Skips code validation" is not "is prose."** A `shallow` profile means
  "this area doesn't need the code gates" — not "this area is written in
  English." Prototype/throwaway code (see `spike` in the worked example) is
  real code deliberately kept on the shallow profile because it never ships;
  a docs area is shallow because it has no code to gate at all — a different
  reason that happens to land on the same profile.

**A remote-machine requirement is a composer's.** The generic plan never
requires a CI-identical [remote test box](../../../../GLOSSARY.md); its JSON
keeps the `validation.testbox` block, the contract
[drive-pr](../../../../plugin/skills/drive-pr/README.md)'s round plan reads,
with `required: false`. A repository whose agents must run some
changes on such a machine computes the requirement in its composer's plan,
and from the *closure* of the seeds rather than the seeds: it protects
dependents. A `core-lib` change seeds only `core-lib`, while `api-service`,
which depends on it and may need the machine, is reached only through the
closure; read from the seeds, the requirement would let the agent run on
its local toolchain instead. This local check is a convenience, not a
substitute for CI: CI re-runs the deepest profile's full gate set regardless
of what the hook computed or skipped (see
[mappings.md](../../mappings.md#agent-gate-depth-validation-wiring)).

The payoff for [M12](../../../M12-parallel-agent-ergonomics/): a pre-push hook
can skip the cross-worktree heavy-run mutex only when the plan selects no
heavy profile **and** requires no remote machine. Profile depth alone is not
enough where a composer computes that requirement: depth is seed-only by
design, so a shallow seed set can still reach, through the closure, a
dependent that needs the machine — the machine-wide serialization
[M1](../../../M1-gates-enforcement-ladder/) points at exists to protect
exactly those runs.

## Generated-output coupling (`generated:`)

[M2](../../../M2-generated-artifact-freshness/) covers artifact freshness;
this field covers the seam between it and the catalog. Each entry is one of
M2's [generated-file inventory](../../../M2-generated-artifact-freshness/reference/inventory/README.md)
entries, declared *on its owning area* — see `api-schema` in the worked
example — which lets that area carry one specific freshness gate (the
entry's `check`, with `command` as the fix it names) without escalating the
whole area to the deepest validation profile, and stops the regenerate command
being copy-pasted across a hook, a CI step, and a paragraph of prose that
then drift independently. The catalog is then the inventory: M2's generic
runner reads every area's `generated:` list and runs every declared check as
one CI step, so a generator added to the catalog cannot ship without its
check.

The `source` globs are as load-bearing as `paths` itself: if a cross-area
generator's source path is mistyped, a naive glob-coverage check still passes
(the string is *some* valid-looking glob) while the coupling silently stops
firing — the area never sees the source change that should have triggered its
regeneration. That is why `generated[].source` is graph-checked against the
filesystem (§ Graph validation, above), not just schema-checked for shape.

**Activation.** A changed file matching `generated[].source` seeds the
*owning* area, exactly as a match against `paths` would — even though the
source usually lives inside a *different* area's `paths`. In the worked
example, `apps/api-service/src/routes/**` is covered by `api-service`'s own
`paths`, not `api-schema`'s; a routes-only diff seeds both. The match counts
for every seed-reading projection (the validation plan, the generated
checks, tracker labels and flags) and for the closure: seeding only the
freshness projection would leave the owning area's checks out of the plan
for a source-only edit. The static projections (the CI path-filter, the
review-gate table) use the same seed globs, so they stay equivalent to the
resolver.

## Grandfathering catalog coverage

The Coverage check (§ Graph validation) is pass/fail, which a brownfield repo
cannot satisfy on day one. Apply the general pattern from
[`adoption/brownfield.md`](../../../../adoption/brownfield.md#grandfathering-a-coverage-gate)
with these catalog-specific sets:

1. **An exception set** (e.g. a checker-side list, not the catalog itself)
   naming workspaces the coverage check may not fail on yet. New workspaces
   may never be *added* to it — only removed as they gain coverage. Enforce
   this mechanically, not by convention: a check diffs the set against its
   value on the base branch and fails if the diff contains an addition.
   Read the comparison side from the trusted base — the base branch's copy
   of the set, or of a frozen baseline file, never the copy in the PR's own
   tree, which the same PR can edit in step with the set — and keep the
   comparison script under required review ownership, so the PR cannot
   weaken the check that judges it. Without that check the set is an
   ordinary in-code list, and a PR introducing a newly-uncovered workspace
   can add it to the same list and keep the coverage gate green — the
   base-branch diff is what makes "may never be added to" observable instead
   of just documented.
2. **A partial-coverage pin set**, one entry per `{glob, path}` pair, checked
   two ways: the glob must still resolve to that literal on-disk path (so
   deleting the files doesn't silently pass), and the pin only suppresses the
   *uncovered* finding for that path — a path that moves from uncovered to
   partially-covered still reports, since narrowing coverage is progress the
   backlog should see, not more silence. Those two checks only see pins that
   still exist, so a third catches a deleted declaration: diff the pin set
   against the base branch's copy, as for the exception set, and fail on a
   removed `{glob, path}` pair unless its path is now fully covered or no
   longer exists in the tree — the only two ways its coverage obligation is
   discharged. A fixture that deletes a pin while its path is still
   partially covered must fail.

Route the resulting backlog to a **live, open** tracking item, not a closed
one — see the brownfield doc's failure mode.

## The self-check paradox

A self-check (see [GLOSSARY.md](../../../../GLOSSARY.md)) cannot ask its
subject whether it should run. The CI step that
validates the catalog's own structure (§ Schema-level validation, § Graph
validation) must run independently of catalog-derived selection — either
unconditionally on every CI event, or behind a hand-written, literal path
match on the catalog file itself — never by resolving changed paths
*through* the catalog to decide whether to run the catalog check. If it did, a change that deletes
the catalog's own paths from the catalog would resolve to nothing, and the one
check that should catch that deletion would skip itself along with it.

A trigger on the catalog file alone is enough only while no area declares
`generated:`. Point 7 of § Graph validation can break without the catalog
changing: deleting the last file a `generated[].source` glob matches leaves
the declaration dangling. So once any area declares `generated:`, either run
the check on every CI event, or extend the trigger with a literal match on
every `generated[].source` glob, deletions included.

Where a trigger is used rather than an unconditional run, it is the single
hand-written shortcut this module treats as *required*, not debt — every other hand-maintained path list (the regex-mirror shortcut
below) is drift to be checked or replaced. It generalizes beyond this module:
any catalog-, config-, or manifest-driven CI has exactly one check that cannot
be gated by the thing it validates.

## The regex-mirror guard

If the repo keeps a fast hand-written CI regex ("did any *code* change?") to
avoid running the full resolver on every event, that regex is a second copy of
part of the catalog and will drift. Four checks keep them honest, covering both
directions at different granularities — see [`../regex-mirror/`](../regex-mirror/)
for the one that's runnable as-is:

| Check | Direction | Catches |
|-------|-----------|---------|
| `checkFilterCoverage` | catalog → regex | a catalog path absent from the regex, for any area whose `impliedBy` closure reaches the regex's *target area class* — [code area](../../../../GLOSSARY.md) for a general shortcut, [deploy-critical area](../../../../GLOSSARY.md) for a deploy-gating one — not just an area that is itself one |
| `checkFilterSegmentCoverage` | regex → catalog, per alternative | a regex alternative no area declares — a literal, path-component-boundary prefix match against **parsed** `paths:` values, never a substring of the catalog file |
| `checkFilterFileCoverage` | regex → catalog, per tracked file | a file the regex calls code-bearing that matches no area |
| `checkFilterCodeAreaCoverage` | regex → catalog, per tracked file, [deploy-critical area](../../../../GLOSSARY.md) — **only for a deploy-gating shortcut regex, not a general "did any code change?" one** | a file the regex calls code-bearing whose area(s) are real but whose `impliedBy` closure never reaches a deploy-critical area |

The portable lesson behind all four: **matching must run against parsed
structured values — the catalog's `paths:` lists, not a substring scan of the
catalog file's text.** A guard that greps its own source of truth as a string
can pass on a comment; a `notes:` field explaining CI history can contain a
prefix the regex checks for without the catalog actually declaring that prefix
as a code-bearing path.

Each check's inputs, algorithm, and failure condition, so independent
implementations can't silently disagree:

### `checkFilterCoverage` (catalog → regex)

- **Inputs:** the areas relevant to the shortcut's target class — every
  regex is checked against one class matching what it actually decides:
  - a general "did any code change?" shortcut targets the
    [code area](../../../../GLOSSARY.md) class directly: every area not on
    an explicit non-code-bearing area-id deny-list, never a `category`
    filter. Closure reachability is checked separately against anchors;
  - a deploy-gating shortcut targets the
    [deploy-critical area](../../../../GLOSSARY.md) class instead — the same
    class `checkFilterCodeAreaCoverage` uses — **not** the code-area class.
    Include every area whose forward closure reaches that class.
    Running this check against the broader code-area class for a
    deploy-gating regex is unsatisfiable together with
    `checkFilterCodeAreaCoverage` whenever some code-bearing area isn't
    deploy-critical (`deployTier: none`, e.g. a CI-tooling area — see the
    glossary entry): this check would require the regex to include that
    area's glob, while `checkFilterCodeAreaCoverage` would then reject
    every tracked file that glob matches. No regex can satisfy both at
    once, so the area class must already be the narrower one going in.

  the regex's alternatives, each normalized to a path prefix (see
  `checkFilterSegmentCoverage` below for the normalization).
- **Algorithm:** for each such area's `paths` glob, compute its **literal
  head** — the substring up to and including the *last* `/` at or before the
  glob's first *variable construct* — every construct the glob dialect gives
  variable, character-selecting meaning: a `*`, whether standalone or the
  start of `**`; a bracket character class `[...]`; a single-character
  wildcard `?`; and, for a dialect that supports it, a brace-expansion group
  `{...}` — never a raw cut at the construct itself; the cut lands at the
  component boundary immediately before whichever construct comes first,
  wherever that is (`apps/web-app/**` → `apps/web-app/` — the trailing `**`
  is the first and only variable construct, so the cut lands right before
  it; `apps/*/src/**` → `apps/`; `apps/web-*/**` → `apps/`,
  **not** `apps/web-` — the wildcard falls mid-component, so the last
  complete component boundary is the one before `web-`; `apps/[ab]/**` →
  `apps/`, **not** `apps/[ab]/` — a bracket class selects among characters
  just as a wildcard does; `apps/web-?/**` → `apps/`, **not** `apps/web-?/`
  — `?` selects among characters exactly as `[ab]` does, one character wide
  instead of an enumerated set; `apps/{web,api}/**` → `apps/`, **not**
  `apps/{web,api}/` — a brace group selects among whole alternatives just as
  a bracket class selects among characters — none of these contribute
  literal text of their own to stop the cut early, whatever the glob
  dialect's actual variable-construct vocabulary is; treat every member of
  it this way, not only `*`). A genuinely wildcard-free path (`package.json`,
  with no variable construct at all) has no cut point to find and is
  already its own entire literal head, unchanged by this step. Assert some
  regex
  alternative's normalized prefix is a path-component-boundary prefix of
  that literal head — the same comparison `checkFilterSegmentCoverage`
  performs, run in the opposite direction — **except**:
  - An alternative that was exact-anchored (normalized via a trailing `$`,
    not `/` / `/.*` — a regex alternative never carries a trailing `/**`;
    see `checkFilterSegmentCoverage` below for why) may only certify
    coverage of a glob that is itself the same wildcard-free literal head
    with no variable construct of its own, and only via an exact string
    match, never a boundary-prefix match against a glob that has one.
  - Symmetrically, a glob with **no variable construct at all** — an exact
    file path such as `package.json`, whose literal head is the whole glob —
    may be covered by a directory-form alternative (`/` or `/.*`) only
    when its normalized prefix is a **strict ancestor** of that literal
    head, i.e. the literal head continues with `/` after the matched
    prefix (`^apps/` against `apps/config.json`: prefix `apps` is a real
    ancestor directory, and the file genuinely lives under it — covered).
    It may **not** be covered when the alternative's prefix would equal the
    *entire* literal head, leaving nothing further (`^package\.json/`
    against `package.json`: the prefix textually equals the whole exact
    file path, but the alternative itself still requires further path
    characters after it — at minimum a `/` — that the exact file path
    never has, so its runtime regex can never actually match that file).
    The distinguishing test is exactly the boundary-prefix check already in
    use: `/`-continuation is a real ancestor relationship and must pass;
    exact equality with nothing left over is not, and must fail.
- **Why truncate to the last `/`, not the raw construct position:** a cut at
  the construct itself (`apps/web-*/**` → literal head `apps/web-`) lets a
  regex alternative like `^apps/web-/` pass as "covering" the glob, because
  `apps/web-` compares equal to the literal head — but that regex only
  matches a literal `apps/web-/` path, never `apps/web-prod/main.ts`, which
  the glob does cover. Truncating to the enclosing component boundary
  instead means the check only ever certifies coverage of whole components,
  never a partial-component coincidence that isn't actually true coverage.
  The same reasoning is why a bracket class or `?` must count as a variable
  construct: `apps/[ab]/**`'s literal head is not `apps/[ab]/`, and
  `apps/web-?/**`'s is not `apps/web-?/`, even though both contribute
  literal-looking characters, because an alternative that matches that exact
  text (`^apps/\[ab\]/` or `^apps/web-\?/`, escaped per
  `checkFilterSegmentCoverage`'s metacharacter rule) matches neither
  `apps/a/…` nor `apps/b/…` for the first, and none of `apps/web-a/…`,
  `apps/web-b/…`, etc. for the second — the paths each glob actually covers.
- **Why exact-anchored alternatives can't cover a wildcarded glob:** `^apps$`
  matches only the single literal path `apps` — never anything under
  `apps/web-app/…`. Comparing its normalized text as a boundary-prefix of
  the literal head `apps/` (as if it were equivalent to the directory-prefix
  alternative `^apps/`) would let it falsely certify coverage of every file
  the glob matches, none of which that regex can actually match.
- **Why a directory-form alternative can't cover an exact-file glob:** for
  the code area's glob `package.json` (no variable construct, so its own
  entire literal head), a directory-form alternative like `^package\.json/`
  or `^package\.json/.*` normalizes to the same prefix `package.json` and
  would pass a boundary-prefix comparison (the "boundary" being trivially
  satisfied by an empty remainder), but its actual runtime regex requires a
  `/` immediately after `package.json` — a plain file path never has that
  trailing character, so it can never match `package.json` itself. Both
  directions of this restriction exist for the same reason: a boundary-
  prefix match only certifies coverage when the *catalog* side genuinely has
  a descendant subtree for the alternative's implied `/…` to land in.
- **Fails when:** a target-area-class-reaching area's glob's literal head
  matches no regex alternative at a boundary (subject to the exact-anchor
  restrictions above) — the shortcut would treat some of that area's changes
  as not belonging to the class it's supposed to be gating (e.g. docs-only,
  for a general code shortcut; not deploy-critical, for a deploy-gating one).
- **Why a literal-head comparison, not a synthesized witness:** testing one
  concrete path built from the glob (e.g. `apps/x/src/y` for
  `apps/*/src/**`) proves only that *some* path in the glob matches some
  regex alternative — a regex alternative that is itself a narrow literal
  with no wildcard of its own (`^apps/x/src/`) can match that one witness
  while missing every other path the glob covers (`apps/y/src/…`), and the
  witness test has no way to notice. Comparing literal heads instead asks
  the question this check actually needs answered — does the regex's fixed
  prefix cover the glob's *entire* variable region — and answers it the same
  way regardless of what a synthesized placeholder segment happens to
  contain.

### `checkFilterSegmentCoverage` (regex → catalog, per alternative)

- **Inputs:** each regex alternative, normalized to a plain path prefix
  (require and strip a leading `^` and a trailing `$` / `/` / `/.*`, then
  strip backslash escapes); every area's **parsed** `paths:` field only —
  never `notes:`, a block scalar's prose, or a nested block's own `paths:`
  key.
- **Precondition:** every alternative must start at the path start and end
  with a supported suffix before it can be certified as a literal prefix, and
  contain no *unescaped* regex metacharacter after that stripping. A trailing
  `/` or `/.*` establishes a path-component boundary and allows descendants —
  it is not an end anchor; only a trailing `$` anchors the regex at the end.
  Concretely:
  - **Leading `^` required.** An alternative without it can match anywhere
    inside a path, not just its start — `apps/` (no `^`) also matches
    `docs/apps/file`, even though it normalizes to the same-looking prefix
    as the anchored `^apps/`.
  - **A trailing `$`, `/`, or `/.*` required — never `/**`.** Anything else
    leaves the alternative's end unbounded — `^apps` (no boundary suffix)
    also matches an undeclared sibling like `apps-old/main.ts`, and a bare
    trailing `.*` with no preceding `/` (`^apps.*`) is exactly as unbounded,
    since `.*` alone imposes no separator. A trailing `/**` is rejected
    outright rather than accepted as a fourth boundary form: unlike a
    catalog glob, where `/**` is well-defined "this directory and
    everything under it" syntax, `/**` in an actual regex is `/` followed
    by two adjacent `*` quantifiers — behavior POSIX ERE leaves
    engine-dependent for duplicate quantifiers, and permissive engines
    (e.g. Bash's `[[ =~ ]]`) commonly collapse it to "zero or more `/`,"
    which lets `^apps/**` match an undeclared sibling like `apps-old` too
    (zero slashes, nothing after) — reintroducing the exact unbounded-match
    risk this precondition exists to close. `/.*` has unambiguous "zero or
    more of any char after a real `/`" semantics in every engine and is the
    supported way to express that. The boundary check below only ever
    examines the *catalog* glob's boundary; nothing else certifies the
    regex side's.
  - **`/.*$` is accepted as equivalent to `/.*`; `/$` alone is rejected.**
    Each of `^apps$`, `^apps/$`, and `^apps/.*$` is a genuinely different
    runtime regex on its face (matching the bare string `apps`; the string
    `apps/` with a trailing slash; or `apps/` plus anything, respectively),
    but a `$` after a greedy `.*` is not a meaningful anchor — `.*` already
    consumes to the end of the string regardless of whether a `$` follows
    it — so `^apps/.*$` behaves identically to the already-supported
    `^apps/.*` and must normalize and pass the same way, not be rejected as
    an ambiguous combined form. `^apps/$`, by contrast, is genuinely
    distinct from both the exact-match `^apps$` and the directory-form
    `^apps/.*`: stripping its `/` and its `$` independently would collapse
    it to the same normalized prefix `apps` as either, guessing at which of
    two real semantics it has, so it stays rejected — write one clean form
    instead: drop the `/` for a true exact match, or drop the trailing `$`
    for a true directory match.
  - **No unescaped regex metacharacter** (`.`, `[`, `]`, `(`, `)`, `{`, `}`,
    `+`, `?`, an embedded `*`, or an embedded `^` / `$`) may remain after the
    above stripping. An unescaped `.` in `^apps.web/`, for instance,
    normalizes to the literal-looking prefix `apps.web`, but the actual
    regex's `.` also matches `appsXweb/`, a path the catalog never declares
    under that prefix. `^` and `$` are only meaningful — and already
    handled — at the very start and end of an alternative; one still
    remaining here is *embedded mid-string* (`^src/$generated/`), where the
    `$` acts as an anchor matching nothing beyond that point, not the
    literal character its normalized-looking form suggests. A
    backslash-escaped metacharacter (`^apps\.web/`) is a literal and
    remains supported — but only when the backslash precedes one of these
    metacharacters, or another backslash (a literal `\` character). A
    backslash before any other character (`^apps\q/`) has engine-dependent,
    undefined-per-POSIX meaning; this gate does not guess at it (e.g. by
    dropping the backslash and keeping the letter) and hard-errors instead,
    since a wrong guess could normalize to a prefix the real regex doesn't
    actually cover. Decoding a supported escape pair means dropping only the
    backslash and keeping the escaped character — **including** for `\\`,
    which decodes to *one* literal `\`, not zero: a blanket "delete every
    backslash character" (rather than decoding backslash-plus-character
    pairs) would strip both characters of an escaped-backslash pair
    independently, turning `^dir\\file/` into the literal prefix `dirfile`
    instead of the correct `dir\file`, and reporting drift against a
    catalog that genuinely declares `dir\file/**`.

  Any violation is a hard error, not a pass or a normal drift failure — a
  gate that can't certify what an alternative matches must not report
  agreement.
- **Algorithm:** reduce each parsed `paths:` value to its **literal head**
  first — the same reduction `checkFilterCoverage` computes above, since a
  `paths:` glob can itself contain a variable construct (`*`, `[...]`, `?`)
  that must not be compared as literal text (see "Why a catalog glob's own
  variable syntax must not be compared as literal text" below) — then assert
  the normalized prefix is a literal prefix of at least one such literal
  head, across all areas, **at a path-component boundary** — the literal
  head's next character after the matched prefix must be `/` or nothing
  (`services` must not match `services-old/**`; a bare substring test would)
  — **except** an alternative that was exact-anchored (a trailing `$`, not
  `/` / `/.*`) instead requires the literal head to **equal the
  prefix exactly**, never a boundary-prefix match: `^package$` matches only
  the literal path `package`, never a descendant like `package/index.js`, so
  a catalog that declares only the descendant glob `package/**` — and never
  the bare literal path `package` itself — does not represent it, even
  though `package` is a component-boundary prefix of `package/**`'s literal
  head `package/`.
- **Why a catalog glob's own variable syntax must not be compared as literal
  text:** an escaped-literal regex alternative like `^apps/\[ab\]/`
  normalizes to the literal prefix `apps/[ab]`, which *is* a literal
  substring of the raw catalog text `apps/[ab]/**` — but that alternative
  only ever matches a directory literally named `[ab]`, while the glob
  actually matches `apps/a/**` and `apps/b/**`, neither of which contains
  that literal text. Comparing against the raw catalog string would
  certify this alternative as covering the glob even though it matches none
  of the paths the glob covers; reducing the catalog value to its literal
  head `apps/` first means the longer prefix `apps/[ab]` can no longer
  index-match it at all, so this false agreement is impossible. The reduction
  is unsurprising for the two common shapes: an ordinary `apps/web-app/**`
  trailing-wildcard glob *does* have a variable construct (the `**`) and
  reduces to the literal head `apps/web-app/` — the substring up through the
  last `/` before it — while an exact, wildcard-free file path has no
  variable construct at all and is already its own entire literal head,
  unchanged by the reduction.
- **Fails when:** a regex alternative's prefix matches no area's `paths:`
  value's literal head at a component boundary (or, for an exact-anchored
  alternative, no literal head equals it exactly) — the regex claims a code
  path the catalog doesn't declare. Runnable today:
  [`../regex-mirror/check-catalog-regex-sync.ts`](../regex-mirror/check-catalog-regex-sync.ts).

### `checkFilterFileCoverage` (regex → catalog, per tracked file)

- **Inputs:** the **tracked-file universe** — every file tracked by git at
  the ref being checked (`git ls-files`), **unioned with every path tracked
  at the PR's base ref** (`git ls-files` there too) — not just the files
  changed in the current diff; this check validates the regex against
  everything the catalog could ever see, not just what moved. A base-ref
  `git ls-files` includes files unchanged by the PR, which the PR's diff does
  not — the two are not equivalent inputs, so the diff cannot substitute for
  a real base-ref listing. The PR's diff paths (added or deleted) are only a
  narrower, *additional* way to recover the base-only files this union cares
  about — the deletions — when a real base-ref checkout isn't available;
  they don't stand in for the base-ref universe on their own. Regex
  alternatives as above.
- **Why the base ref too:** a head-only tracked-file universe misses a file
  deleted (or renamed) in the same change that also removes its catalog
  membership — e.g. a PR that deletes the last file under some area's
  `paths:` glob and drops that glob from the catalog in one commit. At head,
  neither the file nor the catalog path exists, so nothing looks wrong; but
  the CI diff and resolver both still see the deletion, and if the regex
  shortcut still matches that now-gone path, an area-specific deletion gate
  (a mandatory review, a post-deploy step) can be silently skipped. Checking
  the union of base- and head-tracked paths keeps a file visible to this
  check for the one CI run where its removal is the change being made.
- **Algorithm:** for each tracked file, classify it against the filter regex
  and catalog **from the ref it was tracked at** — a head-tracked file
  against the head regex and catalog, a **base-only** file (present at base,
  absent at head) against the **base** ref's regex and catalog — and assert
  every file the applicable regex calls code-bearing also matches at least
  one area's `paths:` glob under that same ref.
- **Why base-only files need base-ref classification, not head's:** the
  scenario the base/head union exists to catch is exactly the one where the
  file's regex alternative and catalog membership are *also* removed in the
  same change — e.g. a PR that deletes the last `legacy/**` file and drops
  both the `legacy/**` glob and the `^legacy/` regex alternative in one
  commit. Classifying that base-only path against the *head* regex and
  catalog finds neither — the alternative is gone, so the file no longer
  even reads as code-bearing — and the check passes having verified nothing.
  Classifying it against the *base* ref's regex and catalog instead asks the
  narrower question this check can actually answer: did base's own regex and
  catalog *agree* that this file was code-bearing before the change removed
  it? That agreement is a necessary precondition for the deletion's gates to
  have had anything to carry — but whether they were actually carried through
  is the resolver's question, not this one; see "what this check does not
  guarantee" below.

  Classifying a base-only file against **head** instead — rather than in
  addition — is unsound, not just unnecessary: base has one area with
  `paths: ["legacy/old/**"]` and another with `paths: ["legacy/shared/**"]`,
  both covered by the single regex alternative `^legacy/`. A PR deletes the
  last `legacy/old/file` and drops the now-empty `legacy/old/**` area, while
  `^legacy/` correctly survives — it's still needed for `legacy/shared/**`.
  That's a legitimate cleanup, but classifying the deleted file against
  **head** would fail it forever: `^legacy/` still matches the (no-longer-
  tracked) literal path, and no head area covers it, with no way to make a
  deleted file's dead path match a live glob again. A base-only file is
  checked against base only.
- **Fails when:** a tracked file the applicable-ref regex calls code-bearing
  matches no area under that same ref — that file would run through the
  fast-path shortcut as "code" while being invisible to the catalog that is
  supposed to be its source of truth.
- **What base-ref classification does *not* guarantee:** this check only
  verifies that the regex and catalog *agree* about whether a base-only
  (deleted) file was code-bearing before the change removed it — a narrower
  promise than "the deletion's review/post-deploy gates actually ran." Even
  when this check passes for a deleted `legacy/file` (base regex and base
  catalog agree it was code-bearing), nothing here forces the **resolver's**
  changed-path resolution or gate-selection logic, run against the *head*
  state, to consume that base classification and gate the deletion
  accordingly — the resolver could still resolve the deletion event to no
  area and skip the gate entirely, and this check would not catch that.
  Nor does it catch the mirror case one level up: a *surviving* area whose
  broader regex alternative outlives a sibling area's deletion (the
  `^legacy/` example above) is exactly the same "does the current shortcut
  still make sense" question, and is equally out of scope — this check
  is scoped to regex/catalog *sync* at the file level, not to the resolver's
  own deletion-gating behavior; verifying the latter is the resolver's
  responsibility, checked separately
  from the regex-mirror guard this module documents.

### `checkFilterCodeAreaCoverage` (regex → catalog, per tracked file, area-class)

- **Scope:** this check applies only to a regex that specifically answers
  "did anything change that a deploy-gating pipeline must react to?" — not
  the general "did any code change?" shortcut `checkFilterFileCoverage`
  validates. A [code area](../../../../GLOSSARY.md) is not required to be
  deploy-critical (a CI-tooling area with `deployTier: none` can be
  legitimately code-bearing without ever gating a deploy — see the glossary
  entry), so running this check against a general code-shortcut regex would
  reject files that regex is correctly, intentionally classifying as code.
  Apply it only when the regex under test exists to decide whether to run a
  deploy-lane-specific pipeline, not the heavy build in general. When it
  applies, run `checkFilterCoverage` (above) against the same deploy-critical
  area class too, not the general code-area class — see that check's Inputs
  for why running the two checks against different area classes is
  unsatisfiable.
- **Inputs:** the same tracked-file universe and regex alternatives as
  `checkFilterFileCoverage`; every area's forward `impliedBy` closure; the
  [deploy-critical area](../../../../GLOSSARY.md) *area class* — every area whose
  `deployTier` is not `none`, read directly off the schema field.
- **Algorithm:** for each tracked file matching a regex alternative and at
  least one area's `paths:` glob, assert that at least one of its matching
  areas' forward `impliedBy` closure reaches a deploy-critical area.
- **Fails when:** a file the deploy-gating regex calls relevant resolves only
  to areas whose closure never reaches a deploy-critical area — the
  deploy-lane shortcut is triggering for a change no deploy-gating area
  actually depends on.

[`../regex-mirror/check-catalog-regex-sync.ts`](../regex-mirror/check-catalog-regex-sync.ts)
implements `checkFilterSegmentCoverage` as specified above — a
component-boundary literal-prefix match against parsed `paths:` values, never
a substring of the catalog file's raw text — as a standalone Bun script. It
assumes the catalog's inline-array `paths:` format and its documented 2-space
indent (an area's own fields sit at exactly 4 spaces, which is also what lets
it skip a `notes:` block scalar's prose and a nested reserved block's own
`paths:` key — both indented deeper); a catalog using YAML block-sequence
`paths:` lists or a different indent width needs a real YAML parser instead.
See [`../regex-mirror/README.md`](../regex-mirror/README.md), and for
`checkFilterCoverage`'s catalog → regex direction as a documented recipe (it
needs the resolver's closure, which the `change-areas` skill's library
exports, so it can be built on the skill).
`checkFilterFileCoverage` and `checkFilterCodeAreaCoverage` are per-tracked-file
refinements of the same regex → catalog direction — same "parse, don't grep
the substring" lesson, walked per file and per area-class instead of per
regex alternative.

**Bidirectional sync is necessary, not sufficient.** Both directions can stay
green while "code-bearing" itself is wrong, because both check against the
same default-inclusive deny-list, not against reality: a file can match a
real area whose `impliedBy` closure never reaches anything that actually
ships, and still count as code-bearing simply because nobody added that area
to the deny-list. The regex and the catalog agree with *each other* while
both disagree with reality. The fix is a *second*, deliberately narrower
list — a **code-bearing anchor** set — that an additional check verifies the
closure actually reaches. See
[`../regex-mirror/README.md`](../regex-mirror/README.md#matching-an-area-is-not-the-same-as-being-code-bearing)
for the failure mode and the audit criteria's [`area-class-resolved`](../../../../GLOSSARY.md)
strict criterion for the mechanical check.
