---
title: "ADR-0024: An epic's ready children are admitted in parallel"
type: adr
status: amended
description: "The dispatcher admits ready epic children in parallel and orders them with other pickups by shared files and waiting time."
lifecycle: permanent
version: "1.1"
last_updated: 2026-11-20
owner: maintainers
decision_date: 2026-11-14
supersedes: ~
superseded_by: ~
tags: [adr, dispatcher, epics, admission, parallelism]
---

# ADR-0024: An epic's ready children are admitted in parallel

**Status:** Amended · **Date:** 2026-11-14 · **Deciders:** Jig's maintainers through pull-request review

## Context

An [epic](../../GLOSSARY.md) is an issue whose sub-issues (its children)
are each delivered as their own pull request. The
[dispatcher](../../GLOSSARY.md) (`jig dispatch`) starts unattended sessions
for the work it is assigned, epics' children included. An epic may carry an
execution plan, a machine-readable block that orders its children and says
which may run together; nothing in Jig writes one yet, so most epics have
none.

Without a plan, the dispatcher started one child of an epic, the top-ranked,
and none while another child was under way. The rule came from making the
dispatcher work an epic the way an interactive `do-item` session does, one
child per session. It costs throughput: ready siblings wait behind one child
while the host's session slots sit free. On the host this record was written
for, ready children waited behind one sibling while the host used at most 21
of its 60 session slots over two days.

The forces:

- **Waiting has a cost too.** A child that waits starts late, and so does
  everything after it. Two children that touch the same files may conflict,
  and resolving a conflict takes a round, but that round is usually shorter
  than the wait the serial rule imposes.
- **Overlap is a property of the work, not of the epic.** Two children of
  one epic may touch nothing in common; two items of different epics may
  touch the same file. A rule keyed on the epic serializes the first pair
  and lets the second through.
- **Hard holds are declared.** Where an order matters it is written down:
  an execution plan's edges, a change area marked `serialize` in the
  change-area catalog (which today holds drives of pull requests, not the
  start of a pickup), a person's hold. A rule that serializes everything
  else guesses at an order nobody declared.

## Decision

The temporary width below ended when [overlap-aware admission](#2026-11-20--overlap-aware-admission) took effect.

**Admission is parallel by default.** The dispatcher starts every ready
child of an epic, within the host's capacity, unless a declared hold says
otherwise: an execution plan's order, a person's hold, or, for a pull request
already open, a `serialize` change area.

**Overlap is a cost weighed against waiting, never an absolute.** When
capacity is free and only overlapping work is ready, that work starts, and a
round of conflict resolution is accepted as the price. Admission that weighs
the overlap of all work in flight, inside an epic and across epics, is
designed separately and replaces the bound below when it lands.

**Until then, a per-epic width bounds parallel children.** For an epic with
no execution plan, `dispatch.epic_width` (a key of the repository's
`dispatch` section, default 4) is the most of its children under way at
once. A child counts while it is started and not waiting on a person: its
session runs or its pull request is open. A child in `ops_pending`, or
parked on a person (`hitl`, `hitl:*`, `manual-ops`, `jig:hold`), does not
count. A child that cannot be read counts, since it may be under way. A
child that waits on the width says so, naming the epic and the width. A
width of 1 is the one-child rule.

An epic with an execution plan is unchanged: its plan sets its own
parallelism.

An interactive `do-item` session still takes one child of an epic. That is
the scope of one session, not a limit on the epic.

This supersedes the one-child rule the dispatcher held for epics without a
plan (rule 3 of [#791](https://github.com/jig-harness/jig/issues/791)), and
calls the width a temporary bound until overlap-aware admission replaces it.

## Alternatives considered

- **Keep one child at a time.** Rejected: it leaves capacity idle to avoid
  conflicts that may not exist, and it does not prevent the conflicts that
  do exist across epics.
- **Unbounded parallelism now.** Rejected for this step: without an overlap
  estimate, an epic with many ready children would fill the host with work
  that may all touch the same files. The width bounds that until admission
  can see the overlap.
- **Require an execution plan for parallelism.** Rejected: nothing in Jig
  writes plans yet, so this is the serial rule under another name.

## Consequences

### Benefits

- Ready children of a plan-less epic start in the same tick, up to the
  width, and use the host's free slots.
- A repository that wants the old behaviour sets `dispatch.epic_width: 1`.

### Costs

- Siblings that touch the same files may now run together, and some of
  their pull requests need a conflict-resolution round.
- The width is a bound with no knowledge of the work. It is temporary, and
  its default is a guess to be replaced by overlap-aware admission.

## Initial implementation

`plugin/dispatch/lib/sources/served-epics.ts` (`serializeEpics`) keeps a
plan-less epic's children up to its width;
`plugin/dispatch/lib/sources/served.ts` counts the children under way;
`plugin/dispatch/lib/section.ts` reads `dispatch.epic_width`. The key is
documented in [CONFIGURATION.md](../../plugin/CONFIGURATION.md#dispatch).

## Extraction (decisions-become-checks)

Not mechanically checkable as a pattern. The dispatcher's tests hold the
behaviour: a width of 4 starts four of five ready children, a parked child
leaves its siblings free, and a width of 1 starts one child at a time.

## Amendments

### 2026-11-20 · Overlap-aware admission

Ready children enter the same overlap tiers as other ready pickups. A
declared execution plan or serialized area can require serial work. The
dispatcher admits overlapping work when a slot is free and no earlier
candidate can use it. It ignores `dispatch.epic_width` and reports its
replacement, `dispatch.overlap`.

The dispatcher's admission and configuration tests hold these rules.
