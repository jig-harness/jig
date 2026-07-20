---
title: "<feature name> — architecture"
type: architecture
status: draft            # draft → accepted (set to accepted only after review)
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
# reviewed: "<reviewer>, <YYYY-MM-DD>, <#issue / PR / commit>"   # required at status: accepted
---

# Architecture: <feature name>

> TEMPLATE — the architecture doc says **how** the PRD's requirements are met.
> It describes the shape; each significant, hard-to-reverse decision is captured
> as its own numbered ADR (link the record, do not bury the decision in prose).
> The `##` sections below are the required skeleton — keep them. Delete these
> notes as you fill it in.

## Architecture overview

The shape in a paragraph and a sketch: the main components, how a request flows
through them, and the principles that govern the design.

```text
<a small diagram or bullet flow: users → surface → services → stores>
```

- **Principles:** <the few rules this design holds to, e.g. one source of truth
  per fact; fail closed; no shared mutable state across boundaries>

## Key decisions

The significant, hard-to-reverse choices. Summarise each here and link the
**ADR** that owns it — the decision, its context, and its consequences live in
the record, not in this doc (see the ADR practice you have adopted). Research
that changed a decision should already have graduated into an ADR too.

| Decision | Choice | ADR |
|----------|--------|-----|
| <e.g. persistence for saved views> | <choice> | <ADR-000N> |
| <e.g. auth / authorization model> | <choice> | <ADR-000N> |

## Components

Each component, its responsibility, and the requirements it serves. Traceability
back to the PRD keeps the *how* honest against the *what*.

### <component name>

- **Responsibility:** <what it owns; what it must never do>
- **Interfaces:** <how other components talk to it — shape, not vendor>
- **Satisfies:** <FR-1, NFR-2, …>

## Data model

The entities this feature introduces or changes, their key fields and
relationships, and their lifecycle (created / updated / retained / deleted).
Schema-shaping changes usually imply a migration — flag it for the epic stage.

- **<entity>:** <key fields> — <relationships> — <retention / deletion rule>

## Interfaces and contracts

The external surface: the operations exposed, their inputs and outputs, and the
compatibility expectations. Note anything that other teams or clients depend on.

- **<operation>:** <input> → <output>; <error behaviour>

## Security and privacy

How the feature authenticates, authorises, and protects data; what personal or
sensitive data it touches and how that is minimised, encrypted, and retained.
Call out anything that warrants a dedicated security review.

- **AuthZ:** <who may do what>
- **Data handled:** <sensitivity, at-rest / in-transit protection, retention>

## Scale and cost

Rough load and cost at each horizon, and what has to change between them, so the
design is not accidentally sized for one moment only.

| Horizon | Load | What changes | Rough cost |
|---------|------|--------------|-----------|
| Launch | <users / requests> | — | <estimate> |
| Growth | <users / requests> | <e.g. read replicas, caching> | <estimate> |

## Risks and open questions

The parts most likely to be wrong, and what would de-risk them. An open question
that blocks a decision is a research-spike candidate.

- **Risk:** <description> — **mitigation / spike:** <what reduces it>

## Traceability

Which requirement each part of the design serves — the check that the
architecture answers the PRD and nothing orphaned crept in.

| Requirement | Met by |
|-------------|--------|
| FR-1 | <component / decision> |
| NFR-1 | <component / decision> |

## Review

<!-- Filled in at acceptance: a terse record that a fresh-context, red-team
     review happened — reviewer + date/ref — then de-scar the body. Remove this
     note. Alternatively record it in the `reviewed:` frontmatter key. -->

## Version history

| Version | Date | Change |
|---------|------|--------|
| 0.1 | <YYYY-MM-DD> | Initial draft |
