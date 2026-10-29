---
title: "ADR-0010: Parking is reserved for the registry's classes, and every autonomous decision is recorded"
type: adr
status: draft
description: "An autonomous run stops for a person only on a decision class the human-in-the-loop registry names, with the decision framed; every other decision it takes is recorded where a person can reverse it"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-29
owner: maintainers
decision_date: 2026-10-29
supersedes: ~
superseded_by: ~
tags: [adr, autonomy, hitl, drive]
---

# ADR-0010: Parking is reserved for the registry's classes, and every autonomous decision is recorded

**Status:** Draft · **Date:** 2026-10-29 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's review drive runs unattended: each round is a fresh agent pass, and
the drive stops for a person by **parking** an item, which records it and
takes it out of the live work. The park took any reason. So a drive stopped
for decisions an agent could take (filing a follow-up issue, deferring a
finding where the tracker adapter cannot file, a choice one pull request can
undo, a review bot's acknowledgement a guard read as a new comment), and the
person who found it stopped got a key and a sentence: they had to rediscover
the options, the consequences and what to do.

The [human-in-the-loop (HITL) registry](../../modules/M7-pr-lifecycle-review/templates/HITL-REGISTRY.md)
already lists the decision classes that must stay a person's (Ready, merge,
release, scope, overruling a person's thread, and the rest), each with its
trigger. What decides when a run stops could be the agent's judgment of
"unsure", or that registry.

## Decision

A park is reserved for the registry's classes. The drive's park names one
(`--class`, read from the repository's `autonomy.park_classes`, by default
the registry template's rows plus `escalated` for a stakeholder call the
review arbiter or `decide` escalates and `human-decision` for a value the
pull request records as a person's decision), and carries a decision record:
the question in one sentence, each option with what it changes and what it
costs, the recommended option and why, the class, the steps a person must
perform, and what the run already did. A park with no class, or with no
record, is refused at every autonomy level. The arbiter's `escalate` ruling
names the class, so the class is the arbiter's ruling and not the agent's
claim. The drive works everything a park does not block before it stops,
and prints each parked decision in full.

Every decision an autonomous run takes outside those classes is recorded
where a person can find and reverse it, in the same step that takes it: a
thread reply with the outcome token and its rationale, a decision-record
comment for a `decide` ruling, the issue body for an issue filed (saying
which skill filed it, from which pull request and why), an entry in the pull
request's `## Deferred` section for a deferral no tracker adapter can file,
and for all of them an entry under the drive's
`## Decisions taken unattended`, with the autonomy level, the class and how
to reverse it. A decision with no record is a defect the round report counts.

How far a run decides on its own is the repository's `autonomy.level`,
capped by its `max_level`; the default, `attended`, is the behaviour before
this decision. The level never moves a registry class.

## Alternatives considered

- **Park whenever the agent is unsure:** the run stops on the questions that
  are cheapest to answer, and the person's morning is spent restarting
  drives. "Unsure" is a confidence, not a class, and a confidence no check
  can read.
- **A free-text reason with a recommended template:** the template is
  skipped exactly when the run is under pressure, and a reason no script
  checks is the bare reason again.
- **Let the agent pick the class:** an agent that wants to stop names the
  nearest class. The arbiter rules the class for a review finding, and the
  class list is the repository's configuration.
- **Decide without recording, trusting the reply trail:** a filed issue, a
  deferral into the body and a `decide` ruling leave no thread reply, and a
  decision a person cannot find is one they cannot reverse.

## Consequences

A run stops only for a person's decisions, and hands each over framed: a
person reads the stop, the handoff file, the drive ledger or the doctor's
`NEEDS_HUMAN` row and decides without rediscovering the question. A
consumer whose own procedures call the park must pass a class and a record,
a breaking change for them. A repository that wants a run to stop on
something more adds a row to its registry and the class to
`autonomy.park_classes`. Raising the level needs the decisions it takes to
stay reversible, which the merge, still a person's
([ADR-0003](ADR-0003-a-person-merges.md)), keeps true: an unattended
decision changes a draft a person reads before anything is released.

## Extraction (decisions-become-checks)

`drive-state.ts park` refuses a park without a class from
`autonomy.park_classes` and without a decision record whose sections it
checks mechanically. The audit's M7 criterion for the published registry
looks for the registry row that reserves parking to the registry's classes.
The drive's handoff file and ledger count a recorded decision with no record
as a defect.
