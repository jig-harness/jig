<!--
  TEMPLATE — copy to docs/adr/ADR-NNNN-<kebab-slug>.md. Pick NNNN as the next
  free zero-padded number (the numbering gate rejects duplicates). Fill in the
  frontmatter and the body sections; delete this comment and any sections that
  don't apply. The worked example below the rule is a neutral illustration —
  replace it entirely. See the module README for the amendment/supersession
  rules. ADR frontmatter is validated by M4's frontmatter checker.
-->

---
title: "ADR-NNNN: <Short Decision Title>"
type: adr
status: draft               # draft -> approved -> amended | deprecated (superseded)
description: "<one-line summary of the decision>"
lifecycle: permanent
version: "1.0"              # bump on each amendment
last_updated: YYYY-MM-DD    # changes when the file changes
owner: engineering
decision_date: YYYY-MM-DD   # the day the decision was made; NEVER changes
supersedes: ~               # ADR id this replaces, or ~
superseded_by: ~            # ADR id that replaced this, or ~
tags: [adr, <topic>]
---

# ADR-NNNN: <Short Decision Title>

**Status:** Draft · **Date:** YYYY-MM-DD · **Deciders:** <who>

## Context
<The forces at play: the problem, constraints, and why a decision is needed
now. State facts, not the choice.>

## Decision
<The choice, stated plainly and imperatively: "We use X." One decision per
ADR.>

## Alternatives considered
- **<Option A>** — <why rejected>.
- **<Option B>** — <why rejected>.

## Consequences
### Benefits
- <what gets better>

### Costs
- <what it costs; the migration; what becomes harder>

## Extraction (decisions-become-checks)
<Triage: is any part of this decision a pattern a gate can verify? If yes, add
a rule to adr-rules.yaml citing this ADR. If no, say so — "not mechanically
checkable".>

<!-- Append amendments below over time; never rewrite the sections above. -->
<!--
## Amendments

### YYYY-MM-DD — <what changed> (v1.1)
<What section this touches, what changed, and why. Cross-link the driving
issue/ADR. Then bump `version` and set `status: amended` in the frontmatter.>
-->

---

<!-- ============ WORKED EXAMPLE (delete when using the template) ============ -->
<!--
---
title: "ADR-0001: Use TOML for service configuration files"
type: adr
status: approved
description: Standardize service configuration on TOML
lifecycle: permanent
version: "1.0"
last_updated: 2026-07-19
owner: engineering
decision_date: 2026-07-19
supersedes: ~
superseded_by: ~
tags: [adr, configuration]
---

# ADR-0001: Use TOML for service configuration files

**Status:** Approved · **Date:** 2026-07-19 · **Deciders:** Platform

## Context
Services mix JSON, YAML, and ad-hoc env files for configuration. The
inconsistency makes tooling, validation, and onboarding harder. We need one
canonical format that is human-editable, supports comments, and types values
unambiguously.

## Decision
All service configuration files use TOML, named `config.toml` at each service
root. JSON remains allowed only for machine-generated artifacts.

## Alternatives considered
- YAML — rejected: significant-whitespace ambiguity and unsafe implicit typing.
- .env — rejected: flat, string-only, no nesting.

## Consequences
### Benefits
- One format, one parser, one schema-validation path.
### Costs
- A one-time migration of existing config files.

## Extraction (decisions-become-checks)
Mechanically checkable: forbid new `config.ya?ml` config files. See rule
PM-101 in adr-rules.yaml.

## Amendments

### 2026-08-02 — Allow config.local.toml overrides (v1.1)
Added an optional developer-local override merged over config.toml at load
time. No change to the base-format decision; extends the loading path only.
-->
