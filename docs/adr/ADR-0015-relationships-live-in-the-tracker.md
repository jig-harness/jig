---
title: "ADR-0015: Relationships live in the tracker's own relations; an execution plan's edges are mirrored, never contradicted"
type: adr
status: draft
description: "An issue's parent, blocks, related and duplicate are written and read only through the tracker's native relationships, with a text marker only where a supported tracker has no native form; an epic's execution plan keeps its dependency edges, its planner writes them as native blocks too, and the reader refuses a plan the tracker contradicts"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-10
owner: maintainers
decision_date: 2026-11-10
supersedes: ~
superseded_by: ~
tags: [adr, tracker, relationships, execution-plan]
---

# ADR-0015: Relationships live in the tracker's own relations

**Status:** Draft · **Date:** 2026-11-10 · **Deciders:** Jig's maintainers through pull-request review

## Context

What may start, in what order and next to what is read from the
relationships between issues: served pickups, the dispatcher's ordering and
the dashboard all follow them. The tracker port names the relationships
(`parent`, and `blocks`, `related` and `duplicate`), and every adapter
writes them through the tracker's own mechanism except two places that kept
a relationship as text:

- GitHub's `related`, written as a marked comment on each issue, because
  GitHub had no such link. It now has one (`addRelatesTo`, an issue's
  `relatesTo`).
- An epic's execution plan, whose block records `dependency` edges between
  its children beside the tracker's own `blocks`, so a dependency could be
  stated twice and the two could disagree.

A relationship kept as text is invisible to the tracker's boards, filters
and people, and Jig has to parse it back.

## Decision

**The rule.** An issue's parent, what it blocks, what it relates to and what
it duplicates are written and read only through the tracker's native
relationships. A text marker stands in for one only where a supported
tracker has no native form, and the adapter declares it. No adapter does
now. A prose line such as "Follow-up of #n" may sit beside the relation,
never instead of it.

**GitHub `related`** is `addRelatesTo`, read from `relatesTo`. The adapter
still reads the comment form as related until `tracker.ts migrate-relations`
has converted each comment to a native link and marked it superseded;
the `tracker-related` record leaves
[RECORDS.md](../../plugin/RECORDS.md) when that migration has run on every
repository that used the old form.

**Execution-plan dependencies: the plan keeps its edges and mirrors them.**
The plan's `dependency` edges stay in the block, with its bands, its
conflict edges and its gates. Its planner writes each dependency edge as a
native `blocks` too (`tracker.ts sync-plan-blocks <epic>` does this and is
safe to repeat), so a person and a board see the same order. The reader
refuses a plan the tracker contradicts: an issue the tracker's `blocks`
makes wait for another that the plan puts after it, by band or by a
dependency edge the other way. A dependency the tracker lacks is no
contradiction; the plan's edge still holds the issue back until the planner
writes it. Conflict edges (two items that must not run at once) have no
native equivalent and stay in the plan only.

## Alternatives considered

- **Dependency edges only as native `blocks`; the plan keeps bands,
  conflicts and gates.** The cleaner end state, with one store for an order.
  Rejected for now: it changes the block's format, so every plan already
  written would need re-writing by its planner before the reader could stop
  reading its edges, and the reader would have to guess which `blocks`
  relations among an epic's children are the plan's. It stays open once no
  plan in the field carries a dependency edge the tracker lacks.
- **The reader makes the plan win, or the tracker win, silently.**
  Rejected: two stores that disagree mean one of them was edited by hand
  and the other was not; naming both issues puts the decision with the
  person who knows which is right.

## Consequences

- A plan written before the rule is read as before. One whose issues the
  tracker already orders the other way stops at pickup with both issues
  named, instead of starting work out of order.
- The check runs where the plan's issues carry their live blockers: pickup
  and the dispatcher's read of an epic's own children. The dispatcher's check
  of an ancestor plan's steps reads no blockers and does not run it. A
  relation on a finished issue orders nothing and is not a contradiction.
- The migration is a one-time step per repository that kept the old form;
  until it has run, `relations` reports native and legacy links alike.
- A new tracker adapter has to name a native form for each of the
  relationships, or declare the marker it falls back to.

## When to reopen

Reopen when a supported tracker offers no native `blocks` (the plan's edges
would then be the only store), or when no plan in the field carries a
dependency edge the tracker lacks, so the edges can leave the block.
