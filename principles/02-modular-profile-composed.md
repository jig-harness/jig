# 2 — Modular, profile-composed

Jig is not a framework you adopt whole. It is **13 modules**
([modules/](../modules/)) that adopt independently, each defined at three
**maturity levels** — Lite, Standard, Strict — and composed by **profiles**
([profiles/](../profiles/)) matching project shapes:

- **Solo/Lite** — short-lived or one-person projects: the minimum that keeps an
  AI-assisted repo coherent (instruction file, basic gates, a glossary).
- **Team/Standard** — production software with multiple contributors: adds
  mechanical enforcement, docs governance, layered review, tracked processes.
- **Regulated/Strict** — compliance-critical work: adds registries (HITL,
  suppression tokens), audit trails, stricter gates, and process observability.

**Why.** Projects differ in size, lifespan, team, and compliance posture; an
all-or-nothing methodology gets adopted by nobody. The single assumption
Jig *does* make: every project, whatever its size, benefits from
scaffolding that lets AI agents work it well (principle 3).

**Consequences:**

- A module never *requires* another module's Strict level; cross-module
  dependencies are declared in the module README and kept minimal.
- Maturity levels are defined by **observable criteria** (one machine-readable
  file per module) so the auditor can score them — not by adjectives.
- Brownfield adoption is one rung at a time; "we adopted the module" means "we
  reached Lite," not "we did everything."
