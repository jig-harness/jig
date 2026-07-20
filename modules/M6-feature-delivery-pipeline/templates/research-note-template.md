---
title: "<question in a phrase> — research note"
type: research-note
status: draft            # draft → accepted
date: <YYYY-MM-DD>       # research notes are dated: they capture what was known then
# reviewed: "<reviewer>, <YYYY-MM-DD>, <#issue / PR / commit>"   # required at status: accepted
---

# Research note: <question in a phrase>

> TEMPLATE — a research note captures one spike: the question, the options
> weighed, the evidence, and a recommendation. It is **dated** on purpose — it
> records what was known on that day, not an eternal truth. When a note *changes
> a decision*, promote that decision into an **ADR**; the note stays as the
> exploration behind it. Delete these notes as you fill it in.

## Question

The one thing this spike exists to answer, in a sentence. Note which stage it is
unblocking (a PRD choice, an architecture decision, a feasibility gate).

## Context

Why the question is open now, and the constraints any answer must respect
(deadlines, existing commitments, things that are fixed). Enough that a reader
months later understands the situation without asking.

## Options considered

Each candidate answer, with its shape and its trade-offs. Be fair to the ones
you will not pick — a straw-man comparison is a review finding.

### Option A: <name>

- **How it works:** <the gist>
- **Pros:** <what it buys>
- **Cons / risks:** <what it costs>

### Option B: <name>

- **How it works:** <the gist>
- **Pros:** <what it buys>
- **Cons / risks:** <what it costs>

## Evidence

What you actually observed — measurements, prototypes, docs, prior art — not
opinion. Link the sources. This is the part an adversarial review challenges
first: does the evidence support the recommendation, or just decorate it?

| Question | What the evidence shows | Source |
|----------|-------------------------|--------|
| <sub-question> | <finding> | <link / measurement> |

## Recommendation

The option you recommend and the single most important reason. State the
conditions under which you would revisit it, and what remains unknown.

- **Recommendation:** <option>, because <the decisive reason>.
- **Revisit if:** <the condition that would change this>.
- **Still unknown:** <what this spike did not settle>.

## Decision graduation

<!-- If this note settles a real decision, open an ADR for it and link it here;
     the ADR is what the project lives by, this note is the exploration behind
     it. If it only informs without deciding, say so. -->

- **Decision recorded as:** <ADR-000N, or "informational — no decision yet">

## Review

<!-- Filled in at acceptance: a terse record that a fresh-context review
     happened — reviewer + date/ref — then de-scar. Remove this note.
     Alternatively record it in the `reviewed:` frontmatter key. -->
