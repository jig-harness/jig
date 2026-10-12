# Model routing policy — tiered model economics

Which model tier handles which kind of work is a cost-load-bearing policy
for any AI-native delivery setup: the expensive models should decide, the
cheap models should explore. This reference states the portable policy; a
consumer repo adopts it by writing one policy page of its own (this file is
a good starting skeleton) and keeping per-agent assignments in exactly one
place.

## The three-tier model and its economics

Route agent work to one of three tiers, chosen so the marginal cost of a
task matches the reasoning it actually needs. Tier names are roles, not
vendor products — fill in whatever your vendor's current lineup is; the
per-vendor examples are in [mappings.md](../mappings.md#model-tiers-per-vendor).

| Tier | Role | Handles | Marginal cost |
|------|------|---------|---------------|
| **Strategic** | Flagship reasoning model | Complex planning, architecture, decision records, novel problem-solving, multi-agent coordination, high-stakes review | Highest |
| **Execution** | Mid-tier workhorse | Implementation, refactoring, multi-file changes, feature development, test writing, docs | Standard |
| **Scout** | Small fast model | Read-only exploration, pattern/schema discovery, validation, link/constraint checks | Lowest (typically several × cheaper than the Execution tier) |

**Why the split pays off.** The majority of agent work is *discovery and
validation*, not reasoning-hard implementation — one observed task mix was
roughly two-thirds Scout-shaped, with only ~5% genuinely Strategic-grade
(treat those numbers as illustrative; re-derive them from your own cost
telemetry). Routing the
majority to the Scout tier — parallelizable, read-only, faster and cheaper
— keeps the expensive tiers reserved for the small slice that genuinely
needs flagship reasoning. Concretely: send scouts (see the
[glossary](../../../GLOSSARY.md)) ahead of implementation so the Execution
agent starts with pre-gathered context and spends fewer tokens exploring.

**Cost tier ≠ role importance.** An agent with a "strategic-sounding"
responsibility does not automatically buy a flagship budget — only
genuinely flagship-hard reasoning does. Tier always means the cost tier
derived from the model, not the prestige of the agent's job title.

## Effort levels compose with tier

Most vendors expose a reasoning-effort control alongside model choice.
Tier chooses *which brain*; effort chooses *how hard that brain thinks*.
They compose independently.

Raise effort for: high-stakes implementation (auth, tenancy boundaries,
migrations, API contract changes), long-horizon autonomous work, hard
reasoning (subtle debugging, adversarial review). Lower it for:
high-volume mechanical work, cost-sensitive routine coding, and any
Scout-tier task — scouts are single-purpose and read-only; keep them at
low effort.

**Composition rule of thumb**: pick the tier from the reasoning class,
then pick the effort from the stakes and horizon of the task. Do not
compensate for an under-powered tier by cranking effort — if an
Execution-tier task keeps needing maximum effort to land, route it to the
Strategic tier instead. (A flagship model at medium effort can be cheaper
*per outcome* than a mid-tier model at high effort on a reasoning-led
task — measure before assuming.)

## Decision rule for a new agent or subagent

Pick the tier by asking, in order — **stop at the first "yes"**:

1. **Is the work read-only discovery or mechanical validation** — finding
   patterns, checking constraints, auditing links, gathering context —
   with no file writes and no multi-step reasoning? → **Scout.** Mark it
   read-only. This is the default for anything whose output feeds
   *another* agent.
2. **Does it write code or docs, refactor, or implement a well-specified
   change** — where the *what* is known and the job is to execute it
   correctly? (A decision record or architecture document is *not*
   well-specified execution even though it "writes docs" — skip to 3.)
   → **Execution.**
3. **Does it require novel reasoning** — architecture, cross-system
   trade-offs, decision-grade choices, multi-agent orchestration, or
   review where a subtle miss is expensive? → **Strategic.**

If two tiers seem to fit, choose the cheaper one and let it **escalate**:
a Scout can hand a "this is harder than expected" finding up to an
Execution or Strategic agent.

## Keep model-version strings in one place

Prose that restates concrete model version strings drifts: once three
documents name a tier's model, they soon disagree on which minor version it
runs. The portable fix:

- The authoritative per-agent model assignment lives **only** in each
  agent definition's configuration (e.g. `model:` frontmatter) — the
  executable truth.
- If you want a human-readable roster, **generate** it from those
  definitions and drift-check it in CI (module M2 covers the
  generate → drift-check pattern). Never hand-edit the roster.
- Policy prose (this page) describes tiers by **family or role**, never by
  pinned version string.
- Vendor model IDs and prices are the vendor's to publish — link to their
  docs rather than restating numbers that will go stale.
