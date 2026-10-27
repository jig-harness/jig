# Routing work to an agent, a model and an effort: design

**What problem this solves.** `do-item` chooses which agent implements an
issue, from the change-area catalog, the issue's labels and its title, but
nothing chooses the model or the reasoning effort, and nothing records why a
choice was made. A one-line copy fix and an epic's architecture spike run on
whatever model and effort the machine was configured with once: the
workspace launcher's Herdr provider starts the agent its settings name, its
Orca provider hands the start to the person, and `do-item`'s delegation
inherits the orchestrating session's model. The policy that says how to
choose exists ([M0's model routing policy](../modules/M0-instruction-architecture/reference/model-routing-policy.md):
the tiers, the effort rule, the judgment-tier admission test), but it is
prose a person applies by hand. With this built, every pickup, launch and
drive pass gets one [route](../GLOSSARY.md): an agent, a
[model tier](../GLOSSARY.md) and an effort, derived from facts the
repository already states, with the reason written where the outcome can be
checked against it, and a person's choice always able to override it.

This is the design of [plan.md](plan.md) item 31, a change to `do-item`,
the [workspace launcher](../tools/launcher/README.md) and `drive-pr`'s arming.
Nothing of it is built. It builds on the agent selection that exists
(`plugin/skills/do-item/scripts/determine_agent.ts`) and on the
[work type](../GLOSSARY.md) derivation of item 27
([work-types.md](work-types.md)), which it waits on.

## The rule

> A route is **derived**, from the item's work type, size and labels, the
> change-area catalog's flags and review risk for the areas the item seeds,
> and the repository's routing rules, and never asked when it can be
> derived. The rules are **data with defaults**: one table per work type
> gives the base tier and effort, and a closed list of **raises** moves the
> effort up one step each, never down; a raise past the highest effort moves
> the **tier** up instead, since an Execution task that keeps needing the
> maximum effort belongs on the Strategic tier (M0). The **strictest value
> wins** on every conflict, and an item whose type cannot be derived takes the
> strictest route. The route carries its **reason** (which rule gave each
> part) and its **source** (the rules, or the person who overrode them), and
> both go where the work's outcome lands, so a rule can be moved on a
> measurement rather than an argument. **A person's choice always wins**,
> and is recorded as the source.

No model is asked to route. M0's boundary principle, mechanize the routine
and escalate genuine judgment, admits a judgment pass only downstream of a
mechanical path that ran and failed to settle the call; with the strictest
value winning, the rules settle every call, so there is no residue to
escalate until the route records show a class of item the rules mis-route
([Left out](#left-out)).

## How it works

### The three parts of a route

| Part | Values | Who takes it |
|---|---|---|
| `agent` | the repository's agent names, as `determine_agent.ts` prints them today | `do-item`'s delegation (the subagent type); the launcher (the Orca or Herdr agent to start, where its id maps to one) |
| `tier` | `scout`, `execution`, `strategic`, `judgment` (M0's tiers, as roles) | translated to a runtime's family alias through `routing.models` before any runtime sees it |
| `effort` | `low`, `medium`, `high`, `max` | translated through `routing.efforts` where a runtime spells a level differently (`max` is `xhigh` in one runtime) |

The tier is a role and never a model id, as M0 requires: the route's
translation to an alias is the only place a model name appears, and that
place is configuration a check can read. The route is therefore one of M0's
declaration points, "an explicit model setting in that skill's
configuration": a caller that forwards it to a subagent tool or a `--model`
flag forwards a declared value and declares nothing new.

### Derivation

`plugin/skills/do-item/scripts/determine_route.ts` reads the issue JSON
`get_issue.ts` returns, runs `determine_agent.ts` for the agent and
`determine_type.ts` (item 27) for the type, and prints
`{agent, tier, effort, reasons, source}`:

1. **The agent**, exactly as today: the catalog area's `agent`, then the
   label map, then the title keywords, then the default. Routing changes
   nothing here; two routes for one choice would disagree
   ([work-types.md § Left out](work-types.md#left-out)).
2. **The base**, from the work type's row of `routing.types` (defaults
   below). `unknown` takes the strictest row computed field by field: the
   highest tier and the highest effort any row names.
3. **The raises**, each moving the effort up one step, applied in this
   order so the reasons read the same way every time:
   - a **flag label** the item carries that is in `routing.raise.flags`; by
     default, every flag the catalog's areas declare under `tracker.flags`
     (a flag is a lasting claim on the record that drives process, so it
     drives this too);
   - a seeded area with **`reviewRisk: high`**: the areas the item's labels
     select through `do_item.agents.codearea_areas`;
   - a **size label** in `routing.raise.sizes` (default `[large]`, the
     taxonomy's largest default size; the labels `batch_sizes` names never
     raise);
   - the **`hitl` label**.
4. **The carry**: an effort raised past `max` stays at `max` and moves the
   tier up one step instead, at most once per route; a route already on
   `strategic` stays there. Nothing routes to `judgment` by derivation: that
   tier is admitted per decision layer with a named baseline (M0), never
   by a rule that fires on every item.
5. **The translation**: tier to the runtime's family alias through
   `routing.models.<runtime>`, effort through `routing.efforts.<runtime>`.
   The runtime is `--runtime <name>` where the caller knows what it will
   start (the launcher), otherwise derived from the environment the way
   [`reflect`](../plugin/skills/reflect/README.md) derives the harness.

Nothing lowers below the type's row: a type lowers depth only where nothing
else raises it, the same rule as [work types](work-types.md#the-rule). The
`reasons` list names which rule gave each part (`tier: execution (type
feature)`, `effort: high (flag has-migration raised medium)`), so a person
reading a route record can see what to change.

The default rows, from M0's ladder (the *what* of a bug, an improvement or a
task is known and the job is to execute it; a feature is longer-horizon
work; a spike's deliverable is a decision, which is novel reasoning):

| Field | `bug` | `feature` | `improvement` | `task` | `spike` |
|---|---|---|---|---|---|
| `tier` | `execution` | `execution` | `execution` | `execution` | `strategic` |
| `effort` | `medium` | `high` | `medium` | `low` | `high` |

The default translation, from [M0's mappings](../modules/M0-instruction-architecture/mappings.md#model-tiers-per-vendor);
a repository on another runtime adds a row, and a repository whose runtime
resolves an alias differently overrides one cell:

| Runtime | `scout` | `execution` | `strategic` | `judgment` |
|---|---|---|---|---|
| `claude-code` | `haiku` | `sonnet` | `opus` | `fable` |
| `codex` | the vendor's `*-mini` name | the mid-tier name | the flagship name | the flagship's top reasoning tier |

### Overrides

A person's choice wins and becomes the route's `source`:

- **In the session.** A person who says which model or effort to use, or
  who opens the agent tab in Orca and picks them, has routed the item;
  `do-item` records `source: person` and forwards what they chose. With
  nobody there, the rules decide: an unattended run never stops to ask
  for a route, since the strictest value is always a safe answer.
- **On the machine.** The launcher's `repos.<label>.<provider>` settings
  (`agent`, `model`, `effort`) stay a standing choice for that repository
  on that machine and win over the route, part by part: a setting that
  names only the agent leaves the model and effort to the route.
- **Never on the item.** A route is not written to the issue as a label or
  a field: labels are lasting claims on the record, and a route is a
  decision at pickup that the next pickup should take again from the facts
  as they stand then.

A repository changes the rules through [configuration](#configuration); that
is policy, not an override, and the reasons name the rule that fired.

### Where it is read

- **`do-item`** runs `determine_route.ts` in its agent step and uses the
  route three times: the delegation passes the model and effort to the
  subagent tool where the runtime takes them (Claude Code's agent tool
  takes a model and an effort; elsewhere, the agent's own definition
  applies, and the route is named in the delegation prompt for the
  runtime to honour where it can); the pull request's description gets a
  `Route:` line (agent, tier, effort, source and the reasons) beside the
  type's body sections, so the route survives the worktree and is read by
  any harness; and the arming of the drive gives the pass command the
  route's model and effort, since a pass edits the same areas under
  review.
- **The launcher**, for a routed issue whose settings name no agent, model
  or effort, runs the script with `--runtime` set to the agent it will
  start, reading `.config/jig.yaml` from the clone the provider already runs
  git in (on this machine, or on a server's host through the same channel
  the cache file travels). The Herdr provider starts the agent with the
  route; the Orca provider keeps handing the start to the person and puts
  the route in the worktree's comment and the first prompt as the
  suggestion to pick from, so the person's choice stays the default there.
  When the clone's rules cannot be read, the launcher does what it does
  today and says so in the launch message.
- **`drive-pr`'s loop-cost reports** ([M11](../modules/M11-process-observability/README.md))
  read the `Route:` line from the description and print it beside the
  rounds, the speed numbers and the verdict, so one report joins the route
  to how the work went without a new store. That join is the measurement M0
  asks for before a tier moves: a person moves a row or adds a raise with
  the reports that show the current rule costs more per converged pull
  request, in either direction.
- **M0's metadata check** reads `routing.models` as a declaration point
  beside agent and skill front matter: an alias outside the known families
  is rejected there as it is in a `model:` field.

### The audit

M0's criteria gain one at Standard: model and effort are routed by rules
the repository declares or inherits, and the reason reaches the pull
request. The `convention` observation is the policy in the instructions
(the routing policy page names the tiers and says routes are derived); the
`advisory` observation is the pickup procedure that routes
(`do-item` with this design built); the `mechanical` observation is the
`Route:` line present on the pull requests the repository's recent
history shows, which the audit reads as evidence beside the score. A
repository whose launcher settings name a model for every repository has
chosen by hand and scores `convention` at most.

## Configuration

| Field | Type | Default | Read by |
|---|---|---|---|
| `routing.types.<type>.tier` | one of the four tiers | the table above | `determine_route.ts` |
| `routing.types.<type>.effort` | `low`, `medium`, `high`, `max` | the table above | `determine_route.ts` |
| `routing.raise.flags` | list of labels, or `catalog` | `catalog`: every flag the catalog's areas declare | `determine_route.ts` |
| `routing.raise.sizes` | list of labels | `[large]` | `determine_route.ts` |
| `routing.raise.review_risk` | `true`, `false` | `true` | `determine_route.ts` |
| `routing.models.<runtime>.<tier>` | the runtime's family alias | the table above | `determine_route.ts`, M0's metadata check |
| `routing.efforts.<runtime>.<effort>` | the runtime's own level name | `codex.max: xhigh`, the rest unchanged | `determine_route.ts` |

A type row for a type outside the effective type set, a tier or effort
outside the closed lists, an alias outside the known families and a raise
list naming a label the taxonomy does not declare are refused when the
configuration loads, with the field at fault. `routing.types` follows the
work-types rule for renamed types: a type the repository added carries a
complete row.

## Build order

1. **The derivation.** `determine_route.ts`, the `routing` section, the
   defaults as data with their tests (one fixture per rule, one for the
   carry, one for `unknown`), documented in
   [CONFIGURATION.md](../plugin/CONFIGURATION.md); `do-item` prints the route
   and changes nothing yet. Waits on item 27's first step, the type
   derivation.
2. **`do-item` reads the route.** The delegation forwards the model and
   effort where the runtime takes them and names its fallback; the
   `Route:` line in the description; the drive armed with the route's
   pass. A fixture shows a flagged bug reaching its pull request with a
   higher effort than an unflagged one, and the `Route:` line saying why.
3. **The launcher.** `--runtime` on the script; the Herdr provider starts
   with the route, the Orca provider suggests it; the settings win part by
   part; the launch message says when the rules could not be read.
4. **The join and the check.** The loop-cost report prints the route; M0's
   metadata check reads `routing.models`.
5. **The audit criterion.**

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
- **Routing on what the machine or the subscription has left.** The plugin
  has no reader of remaining usage: a drive learns of a usage wall only by
  hitting one, and parks (`drive-pr`'s quota-parked stop). A route that
  guessed at a budget would be a dial no measurement set. The drive's park
  and resume stay the answer to a wall.
- **Routing the scouts and the review tiers.** Each is pinned where M0 puts
  it, in its own metadata or the skill's own setting: the scouts on the
  Scout tier at low effort, the pattern review on a fast model, the
  semantic review on the strongest available. A route is for the work's
  implementer, its session and its drive passes.
- **A type that changes the agent**, and a route written to the issue.
  Both are above, under the derivation and the overrides.
- **Re-routing a running drive.** A pass that stops on a wall or a deadline
  is re-armed by the person with the same route; the next pickup derives a
  fresh one.
