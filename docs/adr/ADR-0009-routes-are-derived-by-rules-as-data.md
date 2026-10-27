---
title: "ADR-0009: A route is derived by rules as data, never asked of a model"
type: adr
status: draft
description: "The implementer's agent, model tier and effort come from declared rules over derived facts, opt-in, with the strictest value winning and the reason recorded; a model routes nothing"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-28
owner: maintainers
decision_date: 2026-10-28
supersedes: ~
superseded_by: ~
tags: [adr, routing, models]
---

# ADR-0009: A route is derived by rules as data, never asked of a model

**Status:** Draft · **Date:** 2026-10-28 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's pickup chooses which agent implements an issue from the change-area
catalog, the issue's labels and its title. Nothing chooses the model or the
reasoning effort that agent runs on: the delegation inherits the session's
model, which is whatever the launcher's settings or a person picked, and
nothing records why. The
[model routing policy](../../modules/M0-instruction-architecture/reference/model-routing-policy.md)
says how to choose (tiers by reasoning class, effort by stakes and horizon,
the premium tier admitted one decision layer at a time with a baseline),
but as prose a person applies.

Two places could make the choice: a capable model run before pickup, given
the issue and asked for a route; or rules as data over facts the repository
already derives (the work type, the size and flag labels, the catalog's
flags and mandatory reviews), with defaults a repository overrides.

## Decision

A [route](../../GLOSSARY.md) (agent, model tier, effort) for the
implementer is derived by rules as data, as
[design/agent-routing.md](../../design/agent-routing.md) states them: one
row per work type gives the base, a closed list of raises moves the effort
up and never the tier, the strictest value wins on every conflict, an
underivable type takes the strictest row, an agent whose definition pins a
model keeps its pin against the rules, and a person's choice always wins,
field by field and forwarded explicitly so a pin cannot override it. The
route's reason, source and whether it was applied are written on the pull
request, the proposed route apart from the effective one, where the review
loop's report joins the effective route to how the work went. Routing is
opt-in: a repository that declares no rules has its routes derived and
recorded, and nothing applied.

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
- **Routing on by default:** the default rows apply the policy's ladder and
  are not a measurement; applied on upgrade they would move every
  consumer's implementer to a cheaper model unasked. Jig leaves the
  unproven out until a working repository has validated it.
- **A raise that moves the tier:** turning stakes into a tier is the
  importance-buys-a-tier move the policy rejects; the policy's rule that a
  task which keeps needing the maximum effort belongs on the higher tier
  is a row a person moves with the records, not a step taken per item.
- **The route as a label on the issue:** a lasting claim on the record for
  a decision taken at pickup, which the next pickup should take again from
  the facts as they stand then.

## Consequences

Every route can be explained from the configuration and the issue, and
checked against the outcome. Moving a rule is one field in `routing`, with
a report beside it. A repository that wants a model to route must first
show, from the reports, the class of item the rules get wrong, and admit
the pass for that class alone. The routing table becomes one of the
policy's declaration points, beside agent and skill metadata, which the
policy and the audit's criterion say. The session, the scouts, the review
tiers and the drive's passes keep the model they have, so the judgment
layers a pickup runs are never routed down with its implementer.

## Extraction (decisions-become-checks)

The configuration loader refuses a `routing` value outside the closed
lists, an alias outside the known families for a runtime that has them,
and a tier mapped to a family the list gives another tier, from one
families list in `plugin/shared/` that the policy's mappings link. The audit's M0 criterion reads the `## Route` section of
recent pull requests as evidence beside the score.
