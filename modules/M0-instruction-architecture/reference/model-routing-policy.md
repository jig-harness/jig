# Model routing policy: tiered model economics

**What problem this solves.** Every agent and skill runs on some model, and
models differ by an order of magnitude in what they cost. Without a policy,
the expensive model ends up doing bulk exploration, the cheap one makes calls
it cannot make well, assignments restated in several documents disagree, and
a pin written as an exact version keeps running on a superseded release. This
policy has the expensive models decide and the cheap ones explore, with each
assignment in one place a machine can check. A consumer repository adopts it
by writing its own policy page (this file is a skeleton).

## Invariant

> A [model tier](../../../GLOSSARY.md) is declared only in an agent's or a
> skill's metadata, or, for a judgment pass inside a skill, in an explicit
> model setting in that skill's configuration, and always as a
> [family alias](../../../GLOSSARY.md), never as a versioned model id. A check
> over that metadata rejects anything else, and a
> [model roster](../../../GLOSSARY.md), where one is kept, is generated from
> it and checked for drift. Moving a tier for cost reasons needs a measured
> [cost per completed task](../../../GLOSSARY.md), not an argument. The
> premium [Judgment tier](../../../GLOSSARY.md) is admitted one
> [decision layer](../../../GLOSSARY.md) at a time, each with a named
> [A/B baseline](../../../GLOSSARY.md).

Where a runtime has no family aliases, the pin uses the vendor's most general
model name, or one central name the repository maps to a release in a single
place; either way, no agent or skill carries a release of its own
([per vendor](../mappings.md#model-tiers-per-vendor)).

## The tiers

Route agent work to one of these tiers, chosen so that what a task costs
matches the reasoning it actually needs. Tier names are roles, not vendor
products; which model family fills each role, per vendor, is in
[mappings.md](../mappings.md#model-tiers-per-vendor).

| Tier | Role | Handles | Share of the task mix | List price per token |
|------|------|---------|-----------------------|----------------------|
| **Judgment** | Top reasoning model, used sparingly | Judgment-only, low-volume, high-leverage calls over complex state: the contested residue no mechanical path settled ([below](#the-judgment-tier)) | a target of far below 1% | Highest |
| **Strategic** | Flagship reasoning model | Complex planning, architecture, decision records, novel problem-solving, multi-agent coordination, review where a subtle miss is expensive | about 5% | High |
| **Execution** | Mid-tier workhorse | Implementation, refactoring, multi-file changes, feature work, test writing, documentation | about 30% | Standard |
| **Scout** | Small fast model | Read-only exploration, pattern and schema discovery, validation, link and constraint checks, bulk classification and summarising | about 65% | Lowest |

The Strategic, Execution and Scout shares are one observed task mix, given to
show its shape; the Judgment share is a ceiling to hold, not an observation.
Re-derive them from your own cost telemetry. The Judgment tier is the
narrowest row on purpose, not the top of a ladder every important-sounding
task should climb. Work routed to another provider's models, through another
runtime or an execution harness, follows the same tiers; its model ids,
prices and per-task bindings live with the vendor and the harness's own
routing configuration, never in policy prose.

**Why the split pays off.** Most agent work is discovery and validation, so
routing it to the Scout tier keeps the expensive tiers for the slice that
needs them; [scouts](../../../GLOSSARY.md) sent ahead of implementation also
spare the Execution agent the tokens of looking for context.

**Per-token price is not per-task cost.** The last column ranks list price
per token, which is not what a task costs; how to measure what it does cost
is [below](#moving-a-pin-on-cost-grounds-needs-a-measurement). It changes how
a tier is measured, not how it is chosen: the decision rule still picks by
reasoning class, cheapest first.

**Cost tier is not role importance.** A strategic-sounding role does not earn
a flagship budget; only reasoning that is hard on its own merits does. "Tier"
here always means the cost tier derived from the declared model family.

## Effort composes with tier

The tier picks *which model*; a reasoning-effort setting picks *how hard it
thinks*. Set effort explicitly rather than inheriting a default, since
defaults differ between model generations; a scout pins low effort next to
its model pin. Pick the tier from the reasoning class, then the effort from
the stakes and horizon: raise it for high-stakes implementation
(authentication, tenant boundaries, migrations, API contracts), long-horizon
work and hard reasoning; lower it for mechanical work and every Scout-tier
task. Do not make up for an under-powered tier with effort: an Execution
task that keeps needing the maximum effort belongs on the Strategic tier. That a flagship model at medium
effort costs less per outcome than a mid-tier model at high effort is a
hypothesis worth testing on reasoning-led work, not an established fact:
measure it on your own tasks before routing on it.

## The metadata check and the generated roster

Pins are family aliases because an alias selects the family and ordinarily
resolves to its current release (with the
[resolution exceptions](../mappings.md#family-aliases-and-pins-in-claude-code)
the runtime documents), while a versioned id freezes the pin on a model that
is superseded unnoticed: the tier is the policy's decision, the release the
vendor's. A valid alias is therefore no proof of which release ran. Prose
may name a model descriptively but never assigns one. The authoritative
assignment is each agent's and skill's metadata (a `model:` field in its
front matter, or the runtime's equivalent). A CI check reads that metadata
directly, whether or not a roster file is generated. A value that selects
no model of its own, such as an inheritance selector that keeps the
caller's model ([Claude Code: `inherit`](../mappings.md#family-aliases-and-pins-in-claude-code)),
or an absent field, is not a pin: the check accepts it and derives no tier
from it. For every pin it rejects:

- a model value outside the known families;
- a versioned model id where a family alias is required, in agents and skills
  alike (a recorded baseline is not a pin: it lives in its own field, so a
  versioned id there is expected);
- a declared cost tier, where the metadata carries one, that contradicts the
  tier derived from the model.

It validates what the repository declares, not the environment: some
providers resolve an alias to an older release
([overrides](../mappings.md#family-aliases-and-pins-in-claude-code)).

That check answers **validity**. Whether a given layer *deserves* its tier is
**appropriateness**: the admission test below, a judgment checked when an
assignment is reviewed and when the repository is audited, not by a CI gate.
A structural gate would answer a different question while looking green.

A roster for people to read is the human-readable rendering of the same
metadata: one deterministically ordered generated file that prose links to
rather than embeds. A command regenerates it, and CI fails when the committed
roster differs from a fresh generation, and a commit-time hook regenerates
and stages it, so a local commit never carries a stale one: the full
freshness triad of [M2](../../M2-generated-artifact-freshness/README.md).
M2's preference holds here too: commit a roster only when someone needs it at
rest; otherwise generate it on demand and commit none. To change a tier,
edit the metadata; never edit the roster by hand. A reference generator is
not yet part of Jig ([M0 Status](../README.md#status)).

## Decision rule for a new agent or skill

**First, the judgment-layer pre-check.** Is this a judgment-only decision
layer that passes every clause of the [admission test](#admission-test)? If
yes, it is a Judgment-tier candidate: read [the Judgment
tier](#the-judgment-tier) in full first. The pre-check runs before the
ladder because the ladder's third question, "review where a subtle miss is
expensive", also describes a genuine judgment layer, so a ladder that reached
it first would never ask the judgment question.

**Then the ladder.** Ask in order, cheapest first, and stop at the first yes:

1. **Is the work read-only discovery or mechanical validation** (finding
   patterns, checking constraints, auditing links, gathering context,
   classifying or summarising a bounded slice) with no file writes and no
   multi-step reasoning? → **Scout.** Mark it read-only and pin low effort.
   This is the default for anything whose output feeds another agent. Keep
   each scout short and bounded: several scouts with narrow questions beat
   one long-running scout ([why, per vendor](../mappings.md#model-tiers-per-vendor)).
   The one write-capable exception is a [measured move
   down](#a-candidate-for-a-measured-move-down).
2. **Does it write code or documentation, refactor, or implement a
   well-specified change**, where the *what* is known and the job is to
   execute it correctly, without novel reasoning? → **Execution.** A decision
   record or architecture document is not well-specified execution even
   though it writes documentation: go to 3.
3. **Does it need novel reasoning** (architecture, cross-system trade-offs,
   decision-grade choices, multi-agent orchestration, or review where a
   subtle miss is expensive)? → **Strategic.**

If two tiers seem to fit, choose the cheaper and let it **escalate**: a scout
hands a "harder than expected" finding up to an Execution or Strategic agent.
Record the choice in the `model:` metadata (and in the declared cost tier,
where the metadata carries one).

## Moving a pin on cost grounds needs a measurement

An agent session is billed on several streams at once: uncached input,
writes to the prompt cache, reads from it, and output; in a long session,
cache reads are most of the volume. A tier that finishes in materially fewer
turns can therefore cost less per completed task despite its higher list
price; on mechanical work, where both tiers take the same path, the cheaper
one wins outright; and a cheap tier that fails, or has to be run again, can
cost more than its per-token saving.

So a move between tiers justified by cost needs a measurement, in both
directions: up ("the higher tier finishes in fewer turns") and down ("the
smaller model is close enough here"). Run the agent or skill on a handful of
comparable tasks under both tiers and compare the cost per completed task:
turns or review rounds to completion, wall-clock time, and what was actually
billed, either the observed charges or credits, or each token stream priced
at its own effective rate (a raw token count hides a tier whose tokens cost
more). Under both tiers, also judge the output against the task's acceptance:
findings missed, edits that failed their gate. A run that finishes faster but
is not accepted is not a completed task, whichever direction the move goes.
Record the comparison with the change. A move justified
by the reasoning class (the work turned out to need novel reasoning, or to be
read-only discovery) follows the ladder and needs no comparison.

### A candidate for a measured move down

Current small models may now handle some work the Scout tier was not
designed for: bounded, well-specified, mechanical edits whose correctness a
deterministic gate verifies, such as a codemod-style rename, applying a
decided label set, or regenerating text from a fixed template, where a type
check, test or drift check fails loudly on a bad result. It stays a
hypothesis until a measurement confirms it for a given agent or skill. Until
then, such an edit is Execution work and Scout stays read-only.

Once a measurement confirms it, the move is a recorded exception to the
decision rule's read-only Scout rung, not a reading of it: the agent or skill
keeps its write access, its pin and declared cost tier move to Scout
together, and the measurement recorded with the change is what licenses the
exception. Open-ended implementation, debugging and anything
security-sensitive stay where they are.

## The Judgment tier

**The boundary principle: mechanize the routine, escalate genuine judgment.**
A decision that can be computed is cheaper and more consistent computed than
re-derived by the most expensive model on every run. The Judgment tier exists
for what is left after the computing.

The unit of assignment here is a **decision layer, not a skill or an agent**.
A skill that gathers evidence, ranks it mechanically and then makes one
contested call runs its gathering and ranking on a cheaper tier and only that
final call on the Judgment tier. Splitting the layer out is the work; moving
the whole skill up a tier is the mistake.

### Admission test

A layer belongs on the Judgment tier only when every clause holds. It is a
conjunction, not a menu:

- **Judgment-only.** It rules and explains. It writes no files, edits no
  code, posts nothing, and produces no bulk output. Bounded verification of
  what the caller handed it (reading the code a claim is anchored to, and a
  file the claim cites) is fine; discovering new findings is not.
- **Downstream of a mechanical path that already ran and failed to settle
  it.** If no cheaper rule has been tried, the fix is to write the rule, not
  to buy a bigger model.
- **Low volume, by what triggers it.** A call that fires on every push, file,
  finding or record, whatever a mechanical rule already settled, never
  qualifies. One batched call per round over only the unsettled residue
  does, however many items it rules on.
- **Extreme leverage.** A wrong call costs far more than the tokens: it
  interrupts a person, misdirects days of work, or waves through a defect the
  surrounding loop existed to catch.
- **Complex state.** The inputs do not fit a scoring function anyone would
  trust.

Shapes that pass:

- Jig's [`review-arbiter`](../../../plugin/agents/review-arbiter.md) agent
  rules on the contested residue of a pull-request review that the mechanical
  triage ladder could not settle. It is invoked once per round over that
  residue only, returns one ruling per thread, and writes nothing. Jig's
  plugin ships it unpinned, so it runs on the invoking session's model; a
  consumer that routes it to the Judgment tier pins it in its own agent
  definition.
- A ranking skill whose deterministic scorer ranks the whole population and
  hands one judgment call only the candidates it could not separate (scores
  within a stated margin of each other, or of a cut-off), and makes no
  judgment call at all on a run where the scores settle the order. The call
  must give a reason for every place it departs from the mechanical order.
  The gathering and scoring stay on cheaper tiers; evidence gathering is not
  the judgment.

### Containment

The failure this tier most often produces is not a bad ruling but **creep**:
it arrives on one contested layer, and the next author copies the metadata
because the neighbouring agent has it, or because the decision feels
important (importance buys the Strategic tier, not this one). So every new
Judgment-tier assignment is a reviewable decision on its own merits, never
copied: it records its A/B baseline and its admission, meaning how it meets
each clause of the test and which mechanical rule failed to settle the layer.

### Compliance

A Judgment-tier model may carry different data-retention terms from the
other tiers. Treat its payloads accordingly: if the terms rule out opting a
payload out of retention, assume every payload is retained.

An interactive session is a person deciding, once, what to send. A scheduled
or automated send (a loop, a cron job, a CI job) is a standing external data
flow, and the recurrence is what changes the question. Before wiring one,
keep its payload inside the class of data already approved for that vendor
(for instance engineering source, tracker metadata or synthetic data; never
customer or production data), under the retention and processing terms that
approval assumed. Route anything that widens that class, or a model whose
terms differ from the approved ones (mandatory retention where the approval
assumed none, for instance), through the repository's data-protection review
before the schedule goes live. Billing and enablement can differ too (a separate pool of credits, a
one-time interactive step a headless run cannot take): confirm them in your
own account and runtime before a Judgment-tier layer becomes load-bearing on
an unattended path, and again after a runtime upgrade
([observations, dated](../mappings.md#judgment-tier-access-and-data-retention)).

### Declaration points and the baseline

A tier lives in exactly one of these places, so it can be searched for and
audited:

| Surface | Where its tier is declared |
|---------|----------------------------|
| Agent | `model:` in the agent's metadata, checked and rendered into the roster |
| Skill that pins a model | `model:` in that skill's own metadata |
| Judgment pass inside a skill | an explicit model setting in that skill's configuration |

Never in prose, in a prompt body or in a string literal in a script, and
never as a model chosen at invocation time (a subagent call's model
parameter, a `--model` flag on a spawned CLI) independently of these places:
an invocation-time value outranks the definition's own metadata
([Claude Code](../mappings.md#family-aliases-and-pins-in-claude-code)), and a
tier declared in any of those places is invisible to the check and to the
audit. An invocation-time argument that only forwards a value read from one
of the places above, such as a skill passing its own configured judgment-pass
model to the subagent it calls, declares nothing new and is allowed.

**An A/B baseline is mandatory.** Every Judgment-tier assignment names its
Strategic-tier baseline next to the assignment, in a field of its own (such
as `baseline:` beside `model:`, or the equivalent beside a configuration
setting), so the check knows a versioned id there is a record, not a pin.
Before the comparison has run, the baseline holds the family alias and the
planned comparison; when it runs, the exact versioned id that was measured is
recorded with its result.

**A downgrade is one line.** Reverting a Judgment-tier assignment edits that
single `model:` value or configuration setting back to the baseline's family
alias, together with the declared cost tier beside it where the metadata
carries one (the check rejects a tier that contradicts the model), and
nothing else. It is an exact reversal only while the alias still
resolves to the measured release. Once the family has moved on, or when the
measured baseline itself can no longer be used and some other model stands in
as an operational fallback, the result is a provisional substitution: label
it as one, and measure it again before treating it as the comparison point.
If a downgrade would need changes to prompt text, control flow or output
parsing, the layer was not cleanly separated: fix the seam rather than
accept the coupling.

## Related

- [M2](../../M2-generated-artifact-freshness/README.md): the
  generate-then-drift-check pattern the roster follows.
- [mappings.md](../mappings.md#model-tiers-per-vendor): families per vendor,
  alias mechanics, dated Judgment-tier observations.
- [`review-arbiter`](../../../plugin/agents/review-arbiter.md) and the
  [glossary](../../../GLOSSARY.md).
