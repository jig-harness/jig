# Reality grounding (the Phase 2 audit)

The backend usually has **more grounding than the docs suggest**: direct
schema inspection with `file:line` citations outperforms reading roadmap
product requirement documents. Run this audit *after* the first design lands
(familiar surface) or *before* writing the brief (unfamiliar domain). Either
way, produce two citation-backed tables and a short recommendation.

A finding worth expecting: the backend already implements the lifecycle the
prototype "invented". For example, a design for reviewing AI suggestions on
an order draws a `pending | accepted | rejected | corrected` lifecycle, and
the schema already has exactly that, plus a `stale` state the design missed,
an audit-event table for every decision, and a correction-category enum. The
corrective addenda are then small *because the backend pre-validated the
design intent*. The audit is high-yield and low-cost: do it every time.

## What to check

Find each source in the repository's own layout: a committed schema dump, an
object-relational mapping (ORM) schema, or the migrations; the frontend's
route or page directory for the entity; the service code behind its AI or
automation features.

| Surface | Where to look | Tool |
|---------|---------------|------|
| Entity columns and types | the committed schema (dump, ORM schema, or migrations) | `grep -n "CREATE TABLE .*<entity>"` or the ORM model |
| Related tables (links, suggestions, audit) | same | `grep -n "CREATE TABLE" \| grep -iE "<entity>\|suggestion\|provenance\|audit"` |
| Enums (statuses, categories) | same | `grep -n "CREATE TYPE" \| grep -iE "status\|category\|kind"` |
| Existing routes and components | the frontend's route or page directory for `<entity>` | `ls`, `wc -l`, `head` |
| ADRs and feature docs | the repository's ADR directory and feature documentation | `ls`, targeted reads |
| AI infrastructure | the services behind AI features; schema tables for AI output and suggestions | grep + read |

## What to produce

Two tables with `file:line` citations: one for the entity's content
(metadata), one for AI and automation. Each row:

| prototype expectation | backend reality | congruent? | gap |
|---|---|---|---|
| <what the design assumes> | <what the schema/route actually provides> `file:line` | yes / no / partial | <the delta> |

End with a three-to-five-bullet recommendation, tagged: **realistic now** /
**aspirational** / **design should change** / **biggest-gap files**.

## How the result feeds the brief

- **Congruent rows** → the design intent is validated; note it in `05` as a
  bar the design already meets.
- **"Backend has more than the design knew"** rows → fold the extra states and
  enums into `03` (data shape) so the next round designs for them (e.g. the
  missed `stale` state).
- **"Design should change"** rows → phrase the correction as an *additive
  addendum* ("keep X, Y, Z; add A"), never a redesign. Redesigns lose the
  subtle wins (the layout argument, information architecture per state, the
  shape of AI elements).
