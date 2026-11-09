# Routing work to an agent, a model and an effort: design

**What problem this solves.** `do-item` chooses which agent implements an
issue, from the change-area catalog, the issue's labels and its title, but
nothing chooses the model or the reasoning effort that agent runs on, and
nothing records why a choice was made. A one-line copy fix and an epic's
architecture spike are implemented on whatever model the session happens to
run: the workspace launcher's Herdr provider starts the agent its settings
name, its Orca provider hands the start to the person, and `do-item`'s
delegation inherits the orchestrating session's model. The policy that says
how to choose exists
([M0's model routing policy](../modules/M0-instruction-architecture/reference/model-routing-policy.md):
the tiers, the effort rule, the judgment-tier admission test), but it is
prose a person applies by hand. With this built, the implementer of every
item picked up gets one [route](../GLOSSARY.md): an agent, a
[complexity tier](../GLOSSARY.md) and an effort, derived from facts the
repository already states by rules it declares, with the reason, the source
and whether it was applied written on the pull request, where the review
loop's report joins it to how the work went; and a person's choice always
wins.

This is the design of [plan.md](plan.md) item 31, a change to `do-item` and
`work-batch`, with one line added to the
[workspace launcher](../tools/launcher/README.md)'s first prompt. The
derivation ([build order](#build-order) step 1) is built; the rest is not.
It builds on the agent selection that exists
(`plugin/skills/do-item/scripts/determine_agent.ts`) and on the
[work type](../GLOSSARY.md) derivation of item 27
([work-types.md](work-types.md)), which it waits on. The standing decision
is [ADR-0009](../docs/adr/ADR-0009-routes-are-derived-by-rules-as-data.md).

## The rule

> A route is **derived** from the item's work type, size and labels, the
> change-area catalog's flags, the mandatory reviews of the areas the item
> seeds and of every area their `impliedBy` closure reaches, and the
> repository's routing rules, and never asked when it can be
> derived. The rules are **data with defaults**: the type, the size and the
> flags a repository marks complex give one of three **complexity tiers**,
> one row per work type gives the base effort, and a closed list of
> **raises** moves the effort up one step each, never down and never past
> the highest effort. The
> **strictest value wins** on every conflict, and an item whose type cannot
> be derived takes the strictest row. The route carries its **reason** (which
> rule gave each part), its **source** (the rules, or the person who chose
> instead) and whether it was **applied**, and all three go where the work's
> outcome lands, so a rule is moved on a measurement rather than an
> argument. **A person's choice always wins** and is recorded as the source.
> Routing is **opt-in**: a repository that declares no `routing` section has
> its routes derived and recorded, and nothing applied.

No model is asked to route. M0's boundary principle, mechanize the routine
and escalate genuine judgment, admits a judgment pass only downstream of a
mechanical path that ran and failed to settle the call, at low volume; with
the strictest value winning, the rules settle every call, so there is no
residue to escalate until the route records show a class of item the rules
mis-route ([Left out](#left-out)).

The route is for the **implementer**: the agent `do-item` delegates to, and
the fixes that follow the review inside the same pickup. The orchestrating
session, the scouts, the review tiers and the drive's passes keep the model
they have today ([Left out](#left-out)).

## How it works

### The parts of a route

| Part | Values | Who takes it |
|---|---|---|
| `agent` | the repository's agent names, as `determine_agent.ts` prints them today | `do-item`'s delegation, as the subagent type |
| `tier` | `simple`, `standard` or `complex`, the [complexity tier](../GLOSSARY.md) | translated to the runtime's [family alias](../GLOSSARY.md) through `routing.models.<runtime>.<tier>` before the runtime sees it |
| `effort` | `low`, `medium`, `high`, `max` | translated through `routing.efforts` where a runtime spells a level differently |

A complexity tier says how hard the item is, not which model runs it. By
default the simple and standard tiers map to M0's Execution tier and the
complex tier to its Strategic tier. No tier maps the implementer to a
family M0 places on its Scout tier (`haiku`, `luna`), by default or by
configuration: M0 keeps that tier read-only, and the loader refuses such a
mapping. Within an implementation, the implementer may still hand simple
sub-steps to a Scout model, as a skill chooses its own scouts. No tier's
default is a Judgment family (`fable`, `astra`); the loader accepts one
where a repository configures it for a tier, and the audit reports each
such mapping
([ADR-0009](../docs/adr/ADR-0009-routes-are-derived-by-rules-as-data.md)). The tier is never a model id: the translation table is the
only place a model name appears, and it is configuration a check reads.

### Complexity tiers

The tier comes from the item's type and size and the repository's complex
flags, by one table kept as data in `plugin/skills/do-item/scripts/lib/routing.ts`:

| The item | Tier |
| --- | --- |
| a `spike`, or any item carrying a label in `routing.complex_flags` | `complex`, at any size |
| a `bug`, an `improvement` or a `feature` | `standard` up to M, `complex` from L |
| a `task`, the mechanical type | `simple` up to L, `standard` at XL |
| an `unknown` type | `complex`, the strictest row |

The type and the size are read from the issue's
[facets](../GLOSSARY.md), as every caller of the tracker reads them, and an
unknown size reads as M. `routing.complex_flags` defaults to the
sensitivity names `decide` uses (`has-migration`, `api-change`,
`dpa-relevant`), read from the issue's labels and from the flags of the
catalog's areas it seeds. A configured flag **sets** the tier: an item that
carries one is complex whatever its type and size. That is a rule of the
table, the same for every item, not a raise: a raise still moves only the
effort.

Each tier maps to a model per runtime, the account's vendor choosing the
runtime, with Claude's and OpenAI's families known out of the box:

| Tier | `claude-code` | `codex` |
| --- | --- | --- |
| `simple` | `sonnet` | `terra` |
| `standard` | `sonnet` | `terra` |
| `complex` | `opus` | `sol` |

A repository overrides any cell in `routing.models.<runtime>.<tier>`. The
family aliases and the model each names today are kept in one place,
`plugin/shared/model-families.ts`, which a release updates: Claude's
`haiku`, `sonnet`, `opus` and `fable`; OpenAI's `luna`, `terra`, `sol`
and `astra` (`gpt-6-astra`).
A Codex pass with no model of its own runs the standard tier's Codex model
rather than Codex's own default.

`execution` and `strategic` are accepted as aliases of `standard` and
`complex`, in `routing` and in `drive.pass_model`.

No model is asked for the tier, and no tier or model is written on the
issue. Where a size or a type is missing, the
[steward](../GLOSSARY.md) of [item 44](line-at-capacity.md#the-steward-every-20-minutes)
may fill in the facet, with a comment saying why, and the rules then derive
the tier from it as from any other.

### Derivation

`plugin/skills/do-item/scripts/determine_route.ts` reads the issue JSON
`get_issue.ts` returns, runs `determine_agent.ts` for the agent and
`determine_type.ts` (item 27) for the type, and prints, before the
implementer runs, the proposed route `{agent, tier, effort, model,
reasons}` and, per field, the requested value and its source. It prints
no `applied` and no effective value: `do-item` sets `applied` when it
delegates, and the effective value is what the runtime reports after the
implementer ran ([the record](#where-it-is-read)):

1. **The agent**, exactly as today: the catalog area's `agent`, then the
   label map, then the title keywords, then the default. Routing changes
   nothing here; a second way to pick the agent would disagree with the
   first ([work-types.md § Left out](work-types.md#left-out)).
2. **The base**: the tier from the [complexity table](#complexity-tiers),
   replaced by an explicit `routing.types.<type>.tier` when present,
   with complex flags still forcing complex,
   and the effort from the work type's row of `routing.types` (defaults
   below). `unknown` takes the strictest row: the complex tier and the
   highest effort any row names. An unattended run
   stops on an `unknown` item anyway ([work-types.md](work-types.md#the-depth-table)),
   so that route is taken only in a session where a person can override it.
3. **The raises**, each class moving the effort up one step at most once,
   however many labels of the class the item carries, applied in this order
   so the reasons read the same way every time:
   - a **flag label** the item carries that is in `routing.raise.flags`; by
     default, every flag the catalog's areas declare under `tracker.flags`
     (a flag is a lasting claim on the record that drives process, so it
     drives this too);
   - unless `routing.raise.reviews` is `false`, an area with a
     **mandatory review** among the areas the item's labels seed through
     `do_item.agents.codearea_areas` and every area their `impliedBy`
     closure reaches, the side M3 reads mandatory reviews from (an
     under-triggered review is a missed defect): one whose `review.skills`
     names at least one skill;
   - a **size** in `routing.raise.sizes`; by default, every size the
     repository knows outside `issue_tracker.labels.batch_sizes` (the sizes
     too large to batch), with the known sizes taken as `work-batch` takes
     them (`work_batch.sizes`, else the batchable sizes, always together
     with `review.taxonomy.sizes`), and `[large]` where that leaves none (the
     sizes `batch_sizes` names never raise). Where the repository has a size
     [issue facet](../GLOSSARY.md) (its label taxonomy has a size group), the
     item's size is that facet's value, the facet's values are known sizes
     too, and each size these settings list is read as a size value or as
     the label of one; without one, the item's labels are read;
   - the human-in-the-loop label, `issue_tracker.labels.hitl`, counted
     once even where the catalog also lists it as a flag.
4. **The cap.** An effort raised past `max` stays at `max`; the tier never
   moves on a raise, only on the complexity table's own rows. M0 says to
   choose the cheaper tier and let it escalate, and that an Execution task
   which keeps needing the maximum effort belongs on the Strategic tier:
   that is a row a person moves with the records showing it, or a flag a
   person adds to `routing.complex_flags`, not a step the derivation takes
   per item.
5. **The pinned agent.** An agent whose definition pins a model or an
   effort (Claude Code: `model:` other than `inherit`, or `effort:`, in the
   agent's definition) keeps its pin against the rules: the repository
   decided that agent's tier explicitly, and M0 puts the decision in that
   metadata. The route then supplies only the fields the definition leaves
   open, and the reasons say `tier: pinned by agent`. `determine_agent.ts`
   prints the name the agent is invoked by, not a definition file, so the
   definition is resolved by a per-runtime resolver in `plugin/shared/`
   that reads every scope the runtime loads definitions from (for Claude
   Code: the managed, project, user and plugin scopes, matched on the
   definition's `name:` field, not its file name) in the runtime's own
   precedence order. A name the runtime builds in has no file in any
   scope (Claude Code's `general-purpose`, which is `do-item`'s default
   agent), so the runtime's row in `plugin/shared/` also lists its
   built-in agents with the fields each pins, and a name no scope defines
   resolves there; a definition file of the same name takes the
   precedence the runtime gives it over the built-in. Where the resolver
   cannot find exactly one effective definition, file or built-in, or a
   scope it cannot read could hold one (a definition passed on the command
   line), the rules forward no model and no effort, and the reasons say
   `tier: pin unknown`: a missed pin overwritten by a rule is the failure
   this step exists to prevent.
6. **The translation**: the tier to the runtime's family alias through
   `routing.models.<runtime>`, the effort through
   `routing.efforts.<runtime>`. The runtime is derived from the environment
   the way [`reflect`](../plugin/skills/reflect/README.md) derives the
   harness (that reader moves to `plugin/shared/`, since two skills use it).
   A runtime with no row in `routing.models` gets a route recorded with
   `applied: no` and the reason `no model for <runtime>`.

Nothing lowers below the type's row: a type lowers depth only where nothing
else raises it, the same rule as [work types](work-types.md#the-rule). The
`reasons` list names which rule gave each part (`tier: standard (type
feature, size M)`, `tier: complex (flag has-migration)`, `effort: high (flag has-migration raised medium)`), so a person
reading a route record can see what to change.

The default effort rows, from M0's ladder (the *what* of a bug, an
improvement or a task is known and the job is to execute it; a feature is
longer-horizon work; a spike's deliverable is a decision, which is novel
reasoning):

| Field | `bug` | `feature` | `improvement` | `task` | `spike` |
|---|---|---|---|---|---|
| `effort` | `medium` | `high` | `medium` | `low` | `high` |

The default translation has a row for each runtime whose families
`plugin/shared/model-families.ts` knows, `claude-code` and `codex`, as the
[complexity table](#complexity-tiers) gives them. A repository on another
runtime declares that runtime's row with the names the runtime takes; until
it does, its routes are recorded and not applied.

### Sources and overrides

A route's `source` is `rules`, `person`, `settings` or `pin`, recorded per
field,
and a person's choice wins. Overrides apply **field by field**: a choice
of the model leaves the effort to the rules, and a choice of the effort
leaves the model to them. The precedence, for each of the model and the
effort, is: a value the person names, then a value the settings name, then
the agent definition's pin, then the rules.

- **The person names a value.** When the person says in the session which
  model or effort to use, `do-item` forwards that value explicitly, as it
  would a rule's, and records `source: person` for that field. Explicit,
  not omitted: omitting a field leaves the implementer on the agent
  definition's pin where there is one (Claude Code also lets a
  definition's `effort:` take precedence over the session's), so a choice
  carried by omission would be overridden by the very pin it was meant to
  beat. Where the runtime's tool cannot forward the field, it is recorded
  `applied: no` with the reason, never as applied.
- **The person chose the session.** The launcher's first prompt carries
  one line, `route: yours`, when it handed the agent's start to the person
  (the Orca provider without an `agent` setting): the person chose the
  session's model and effort for this work, without naming them to
  `do-item`. On that line `do-item` forwards neither field, so the
  implementer inherits the session's values except where the agent
  definition pins one, and records `source: person`, `applied: inherited`
  for each field the definition leaves open and `source: pin` for each it
  pins. The source is declared by the prompt and the person, not
  verified: no runtime exposes the session's model to a script before
  the delegation, so the effective value of an inherited field is what
  the runtime reports it resolved, or unknown
  ([the record](#where-it-is-read)).
- **The machine's settings.** When the launcher's `repos.<label>.<provider>`
  settings name a model or an effort, the first prompt says so
  (`route: settings model=<alias> effort=<level>`, naming only the fields
  set), and `do-item` forwards each named value explicitly, recording
  `source: settings` for it; a field the settings leave out is derived by
  the rules. A setting that names only the agent chooses nothing about the
  model or the effort, and the rules apply to both.
- **Nobody there and no line.** The rules decide, and an unattended run
  never stops to ask for a route: the strictest value is always a safe
  answer for the work, if not the cheapest.
- **Never on the item.** A route, its tier and its model are not written
  to the issue as a label or a field: labels are lasting claims on the record, and a route is a
  decision at pickup that the next pickup takes again from the facts as
  they stand then.

A repository changes the rules through [configuration](#configuration); that
is policy, not an override, and the reasons name the rule that fired.

### Where it is read

- **`do-item`** runs `determine_route.ts` in its agent step. Where the
  repository declares `routing`, the delegation passes the model and the
  effort to the subagent tool where the runtime takes them (Claude Code's
  agent tool takes both); where the runtime's tool takes neither, the
  implementer runs as today and the route is recorded with `applied: no`
  and the reason. `applied` says only what `do-item` did with a field:
  `yes` when it forwarded the value and the tool took it, `no` with the
  reason when it forwarded nothing, `inherited` when it left the field to
  the session on purpose. It never says what the implementer ran on. A
  tool that takes the values does not prove they were used: a runtime
  can replace a forwarded model or lower a forwarded effort with no
  variable set (Claude Code: a model allowlist substitutes another model,
  an effort cap limits the level), and what a variable does changes
  between runtime versions (Claude Code's `CLAUDE_CODE_SUBAGENT_MODEL`
  is a default from 2.1.251, and forces only beside
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`). So no reading of the request and
  the environment establishes the effective value, and the record takes
  it from the runtime (the pull request's description, below).
  Each runtime's row in `plugin/shared/` lists, per runtime version, the
  variables known to change a forwarded field, and `determine_route.ts`
  names each one set in the reasons, as a lead for a person reading the
  record, never as the effective value.
  The route is never put in the delegation prompt: a
  prompt cannot change a model, and M0 forbids a tier in prose. The fix
  loop after the review delegates to the same agent with the same route.
  Where `routing` is absent, the route is derived and recorded with
  `applied: no (routing not declared)` and nothing is forwarded, so a
  repository sees what the rules would do before it opts in.
- **The pull request's description** gets a `## Route` section in a fixed
  form, written and parsed by `plugin/shared/route.ts` so a reviewer's
  edit elsewhere in the body leaves it readable. Each line answers one
  question, so no value passes for another: the **proposed** route is what
  the rules derived; the **requested** value of a field is what the
  person, the settings or the agent definition's pin named in their place;
  the **effective** value is what the implementer ran on. The form:
  `proposed: agent=<name> tier=<tier> effort=<effort>
  model=<alias or none>`, then `requested: tier=<tier or none>
  effort=<effort or none> model=<alias or none>`, then `effective:
  tier=<tiers or unknown> effort=<efforts or unknown> model=<aliases or
  unknown>`, then per field `source=<rules|person|settings|pin>
  applied=<yes|no|inherited>`, followed by the reasons. A requested field
  is `none` when nothing but the rules named it, and `unnamed` when the
  person chose the session without naming the value (`route: yours`). An
  effective value is only one the runtime reports it resolved for that
  invocation, read after the implementer ran (Claude Code's transcript
  names the model of each response); a field the runtime reports nothing
  for is `unknown`, whatever was forwarded, named by the person or the
  settings, pinned or set in a variable, and never the proposed or
  requested value in its place. Each effective field is every value the
  runtime reports for it across the invocation's responses, in the order
  first seen (the effective tier is each reported model's tier), and a
  field with more than one value is marked `mixed`, each field on its
  own: a runtime can move a run to another model after a request fails
  (Claude Code's fallback model chains), and resolves the effort per
  model, so the models a run moved between can also have run it at
  different efforts, while two models of one tier leave the tier single.
  A field holds what the runtime established only where it reports a
  value for every response of the invocation: one it reports for some
  responses and not others (an effort reported before a fallback and not
  after it) keeps the values it did report and is marked `partial`, each
  field on its own, so a value seen for part of a run never stands for
  the whole of it. One grammar writes every effective field, and
  `route.ts` both writes and parses it:
  `<field>=<value>[,<value>…][;mixed][;partial]`, each value once, in
  the order first seen, the markers after the values in that order, and
  `<field>=unknown` alone when the runtime reported nothing
  (`effort=high,max;mixed;partial`). A value is a single token, a tier,
  an effort or a model name as the runtime reports it, so nothing is
  escaped: `route.ts` refuses to write a value holding whitespace, `,`,
  `;` or `=`, and records the field `unknown` with the refused value in
  the reasons.
  It survives the worktree
  and is read by any harness, as the type's body sections are.
- **`work-batch`** takes one route for the batch: the strictest tier and
  effort across its items, each item's reasons kept. An epic whose issue
  routes to more than two agents keeps its integrator on the session's
  model, and each delegate gets the route.
- **`drive-pr`'s loop-cost report** (`loop-metrics.ts`,
  [M11](../modules/M11-process-observability/README.md)) adds the
  description to what it reads of a pull request, and prints the route
  beside the rounds and threads to convergence, so one report shows rounds
  per route. It groups by the **effective** route, never the proposed one,
  and a comparison per model, per tier or per effort leaves out every pull
  request whose effective value for that field is `unknown` or marked
  `mixed` or `partial`: two people inheriting different models under one
  proposed route are not one route, a run that moved between models or
  efforts is not a run on either, and a run observed for only part of
  its responses is not evidence for the rest.
  That report measures rounds, not cost. A tier move still needs the
  comparison M0 asks for, comparable tasks under both tiers with what was
  billed; the person's overrides and the rules' defaults, read from the
  report across pull requests of one type and area, are how that
  comparison is run, and a person moves the row with the report beside the
  change.
- **M0's declaration points** gain a row: the routing table in the
  repository's configuration (`routing.models`), beside agent and skill
  metadata. The policy's invariant, its table and the audit's
  `model-pins-are-family-aliases` criterion say so, and the configuration
  loader is the check. One list of known families per runtime in
  `plugin/shared/` (`model-families.ts`), which M0's mappings link,
  records the tier M0's mappings give each family (for Claude Code:
  `haiku` scout, `sonnet` execution, `opus` strategic, `fable` judgment; for
  Codex: `luna` scout, `terra` execution, `sol` strategic, `astra`
  judgment, rows M0's mappings gain at step 4). The loader
  refuses an alias outside the list, and a `routing.models` row in which a
  stricter complexity tier maps to a family of a lower M0 tier than a
  lighter one: `complex: sonnet` with `standard: opus` would make the
  strictest tier the cheaper family, the declared tier contradicting the
  model's that M0's policy rejects. A repository whose mapping
  legitimately differs (a provider whose alias resolves to another family)
  declares the family's tier in `routing.family_tiers.<runtime>.<family>`
  with a `reason`, which the loader reads in place of the list's tier for
  that family and refuses without the reason; the audit reports each one.
  A runtime with no list takes any name.
  Independently of ordering, the loader refuses any tier mapped to a
  Scout family, and a `family_tiers` override cannot move a Scout family
  out of that refusal. A tier mapped to a Judgment family is accepted when
  the repository configures it, never by default, and the audit reports
  each one beside the model mapping.

### The audit

M0's criteria gain one at Standard: the implementer's model and effort are
routed by rules the repository declares, and the reason reaches the pull
request. The `convention` observation is the policy in the instructions:
the routing policy page names the tiers and says routes are derived. The
`advisory` observation is a `routing` section with the pickup procedure
that routes (`do-item` with this design built). There is no `mechanical`
observation yet: a required check that the pull request's `## Route`
section parses and agrees with the base branch's rules is future, and until
it exists the criterion scores `advisory` at most. Beside the score, as
evidence, the audit reads the `## Route` section of the pull requests the
repository's recent history shows and reports the share routed by the
rules, the share a person chose and the share recorded and not applied.

## Configuration

| Field | Type | Default | Read by |
|---|---|---|---|
| `routing` | mapping; `{}` accepts every default | absent: routes derived and recorded, none applied | `determine_route.ts`, do-item, work-batch |
| `routing.complex_flags` | list of labels | `[has-migration, api-change, dpa-relevant]`: an item carrying one is complex at any size | `determine_route.ts` |
| `routing.types.<type>.effort` | `low`, `medium`, `high`, `max` | the table above | `determine_route.ts` |
| `routing.types.<type>.tier` | optional complexity tier; legacy `execution` and `strategic` mean `standard` and `complex` | absent: derive from type and size | `determine_route.ts` |
| `routing.raise.flags` | list of labels, or `catalog` | `catalog`: every flag the catalog's areas declare | `determine_route.ts` |
| `routing.raise.sizes` | list of labels | the known sizes (`work_batch.sizes`, else the batchable sizes, always with `review.taxonomy.sizes`) outside `batch_sizes`; `[large]` where that leaves none | `determine_route.ts` |
| `routing.raise.reviews` | `true`, `false` | `true` | `determine_route.ts` |
| `routing.models.<runtime>.<tier>` | the runtime's family alias, per complexity tier | `claude-code: {simple: sonnet, standard: sonnet, complex: opus}`, `codex: {simple: terra, standard: terra, complex: sol}` | `determine_route.ts`, the configuration loader, `drive-pr`, the dispatcher |
| `routing.efforts.<runtime>.<effort>` | the runtime's own level name | unchanged | `determine_route.ts` |
| `routing.family_tiers.<runtime>.<family>` | `{tier, reason}` | none: the tier the known-families list gives | the configuration loader, the audit |

**Existing type overrides keep their precedence.** An explicit
`routing.types.<type>.tier` replaces the type/size table's initial tier,
then complex flags may force complex. The existing raise rules still
raise only effort. Its effort override is retained independently. The
loader normalizes legacy tier
values and legacy model keys (`execution` to `standard`, `strategic` to
`complex`). If a runtime row declares both an old and new key, identical
values coalesce and different values are refused with both field paths;
neither silently wins. Before filling runtime defaults, the loader uses a
legacy `execution` model as the fallback for both `simple` and `standard`;
an explicit `simple` model replaces only that fallback. A legacy model that
names a Scout family is refused like any other Scout mapping. This applies to
custom runtimes too, even when they have no built-in defaults. Without a
legacy `execution` key, an omitted `simple` uses its runtime default.
This preserves an existing `bug: {tier: strategic, effort: high}`
as complex/high even for a small bug. The route records the explicit
override as its reason.

Loading the configuration refuses, with the field at fault: a type row for
a type outside the effective type set, or a type in the set with no
complete row where the repository renamed it (the
[work-types rule](work-types.md#configuration)); a tier or effort outside
the closed lists (`execution` and `strategic` read as `standard` and
`complex`); an alias outside the known families for a runtime that
has them; a `routing.models` row in which a stricter complexity tier maps
to a family of a lower M0 tier (from the list, or from
`routing.family_tiers`) than a lighter one; a
`family_tiers` entry with no reason; and, where the repository has a label taxonomy
(`issue_tracker.taxonomy`), a raise list the repository declares naming a
label the taxonomy does not declare. A default list is never refused: a
default label the taxonomy does not declare raises nothing, since no item
carries it. A refused `routing` section stops `do-item` and says why, as a
refused `do_item` section does today; it is never read as absent.

## Build order

1. **The derivation.** `determine_route.ts`, the `routing` section and the
   defaults as data with their tests (one fixture per rule, one for the cap,
   one for `unknown`), documented in
   [CONFIGURATION.md](../plugin/CONFIGURATION.md); `do-item` prints the route
   and changes nothing yet. Waits on item 27's first step, the type
   derivation.
2. **The complexity tiers**, item 44's step 9
   ([#640](https://github.com/jig-harness/jig/issues/640)): the tier table
   with type and size read from the issue's facets, `routing.complex_flags`,
   `routing.models.<runtime>.<tier>` with the `claude-code` and `codex`
   defaults, `plugin/shared/model-families.ts`, `determine_route.ts`
   printing the tier and what decided it, a Codex pass with no model of
   its own on the standard tier's model, and the old tier names read as
   the new ones. Done when an S bug routes standard and the same bug
   labelled `has-migration` complex, a Codex account runs a complex item
   on `sol` and a standard one on `terra` with no `routing.models` set,
   and a repository that still names `execution` and `strategic` routes
   as before. Migration fixtures cover a small task with
   `claude-code: {execution: opus, strategic: opus}` retaining `opus` as
   simple, a custom runtime with only legacy model keys retaining its
   execution model for simple and standard, an explicit simple model
   overriding the compatibility fallback, and conflicting legacy/new
   keys being refused.
3. **The record.** `plugin/shared/route.ts` writes and parses the `## Route`
   section, proposed, requested and effective values apart; `do-item` writes it with
   `applied: no`; the loop-cost report reads the description and prints
   the route, grouped by the effective one. Recording comes before any
   forwarding, so the first routes applied are already measured.
4. **M0's declaration point.** The policy's invariant and table, the
   criterion's statement, the known-families list with each family's tier
   in `plugin/shared/`, `routing.family_tiers`, and the loader's alias and
   tier checks; M0's mappings link the list.
5. **`do-item` forwards.** Behind a declared `routing` section: the
   delegation passes the model and effort where the runtime's tool takes
   them, field by field, records `applied`, and records the effective
   value the runtime reports after the implementer ran; the definition
   resolver, built-in agents included, keeps a pinned agent's pin and
   forwards nothing where it cannot resolve one, with a fixture for each;
   the fix
   loop reuses the route; the launcher's first prompt carries the `route:`
   line and `do-item` honours it. Fixtures show a flagged bug delegated on
   a higher effort than an unflagged one, the `## Route` section saying
   why; a `route: yours` prompt delegating with nothing forwarded; a person
   naming only the model, with the effort still derived; a forwarded
   model the runtime replaced, recorded `applied: yes` with the replacing
   model as effective; a person's model the runtime replaced, with the
   rules' answer, the person's and the runtime's all kept; an implementer
   that moved to another model mid-run and ran it at another effort,
   recorded with both models and both efforts, each field `mixed`; an
   effort the runtime reports before a fallback and not after it,
   recorded with that effort and marked `partial`; a field the
   runtime reports nothing for, recorded `unknown`; and each of these
   records written by `route.ts` and parsed back to the same values and
   markers, a reported value holding a delimiter recorded `unknown`.
6. **`work-batch` and the audit criterion.**

## Left out

- **A model that routes.** M0 admits a judgment pass only downstream of a
  mechanical path that ran and failed to settle the call, at low volume
  and with a named baseline; a router that fires on every pickup fails
  the volume clause, and with the strictest value winning the rules leave
  nothing unsettled. It becomes a candidate once the loop-cost reports
  show a class of item (a type, an area) the rules route to a tier that
  does not converge, and then as one decision layer over that class only.
- **Rules that move themselves.** The reports are the measurement; a
  person moves the rule, with the report beside the change, as M0 asks for
  every move between tiers. An automatic move would be a tier decided by
  a number no one checked.
- **Routing on by default.** The default rows are M0's ladder applied, not
  a measurement; until a working repository has validated them they stay a
  record a repository reads before it opts in, so an upgrade changes no
  consumer's model.
- **The launcher computing the route.** The launcher reads the issue's
  repository label and the cache only, through one tracker; the
  repository's rules, catalog and taxonomy live in a clone that may be on
  a server's host, which the launcher writes to and does not read from;
  and the Herdr tool takes an agent kind and no model or effort. Each is a
  change of its own, and the route is applied in the session minutes later
  by `do-item` with every input at hand, so the launcher only says what it
  did (the `route:` line). A Herdr `--model` and `--effort`, and a route
  suggested in the Orca worktree's comment, are future, once the launcher
  can read the rules where the clone is.
- **Routing the session and the drive's passes.** The session runs the
  review's triage, the decline ladder and the `review-arbiter`, none of
  which the plugin pins; a session or a pass routed down for a `task`
  would run those judgment layers on a cheaper model, which is the depth
  inside the drive [work types left out](work-types.md#left-out) for the
  same reason. The session's model is the person's or the launcher's
  choice; a pass keeps the model the drive was armed with.
- **Routing the scouts and the review tiers.** Each skill chooses them in
  its own text (the scouts and the pattern review on a fast model, the
  semantic review on the strongest available), the place M0 puts a skill's
  own choice. A route is for the implementer.
- **Routing on what the machine or the subscription has left.** The plugin
  has no reader of remaining usage: a drive learns of a usage wall only by
  hitting one, and parks (`drive-pr`'s quota-parked stop). A route that
  guessed at a budget would be a dial no measurement set.
- **A type that changes the agent**, and a route written to the issue.
  Both are above, under the derivation and the sources.

## Review

Reviewed on 2026-10-28 at commit `8cd255d`, by a fresh-context agent
session acting as an adversary, before the first pull request that builds
it.
