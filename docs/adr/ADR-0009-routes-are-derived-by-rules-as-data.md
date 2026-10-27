---
title: "ADR-0009: A route is derived by rules as data, never asked of a model"
type: adr
status: draft
description: "The agent, model tier and effort for a piece of work come from declared rules over derived facts, with the strictest value winning and the reason recorded; a model routes nothing"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-27
owner: maintainers
decision_date: 2026-10-27
supersedes: ~
superseded_by: ~
tags: [adr, routing, models]
---

# ADR-0009: A route is derived by rules as data, never asked of a model

**Status:** Draft · **Date:** 2026-10-27 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's pickup chooses which agent implements an issue from the change-area
catalog, the issue's labels and its title. Nothing chooses the model or the
reasoning effort: every launch and delegation runs what the machine was
configured with once, or what a person picks by hand, and nothing records
why. The [model routing policy](../../modules/M0-instruction-architecture/reference/model-routing-policy.md)
says how to choose (tiers by reasoning class, effort by stakes and horizon,
the premium tier admitted one decision layer at a time with a baseline),
but as prose a person applies.

Two places could make the choice: a capable model run before pickup, given
the issue and asked for a route; or rules as data over facts the repository
already derives (the work type, the size and flag labels, the catalog's
review risk), with defaults a repository overrides.

## Decision

A [route](../../GLOSSARY.md) (agent, model tier, effort) is derived by
rules as data, as [design/agent-routing.md](../../design/agent-routing.md)
states them: one table per work type gives the base, a closed list of
raises moves the effort up and carries into the tier past the highest
effort, the strictest value wins on every conflict, an underivable type
takes the strictest route, and a person's choice always wins. The route's
reason and source are written on the pull request, where the review loop's
reports join them to how the work went.

No model is asked to route. The policy's own admission test for a judgment
pass requires a mechanical path that ran and failed to settle the call, at
low volume; a router that fires on every pickup fails the volume clause,
and with the strictest value winning, the rules leave no call unsettled. A
judgment pass over one class of item becomes a candidate only when the
reports show the rules route that class to a tier that does not converge,
and then with the baseline and the measurement the policy requires.

## Alternatives considered

- **A model that routes every item:** a choice no check can read, made
  again on every run at the cost of a capable model, with no mechanical
  path tried first; the policy names this the mistake its judgment tier
  exists to avoid.
- **Rules that move themselves from the reports:** a tier decided by a
  number no one checked. The reports are the measurement; a person moves
  the rule with the report beside the change, as every move between tiers
  requires.
- **The route as a label on the issue:** a lasting claim on the record for
  a decision taken at pickup, which the next pickup should take again from
  the facts as they stand then.

## Consequences

Every route can be explained from the configuration and the issue, and
checked against the outcome. Moving a rule is one field in `routing`, with
a report beside it. A repository that wants a model to route must first
show, from the reports, the class of item the rules get wrong, and admit
the pass for that class alone. The machine's launcher settings remain a
standing choice that wins over the route, so a person who has chosen is
never overruled.

## Extraction (decisions-become-checks)

The configuration loader refuses a `routing` value outside the closed
lists, and the model routing policy's metadata check reads
`routing.models` as a declaration point, so an alias outside the known
families is rejected there as in an agent's front matter. The audit's M0
criterion reads the `Route:` line on recent pull requests as evidence.
