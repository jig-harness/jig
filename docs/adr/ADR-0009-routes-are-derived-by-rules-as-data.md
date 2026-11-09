---
title: "ADR-0009: A route is derived by rules as data, never asked of a model"
type: adr
status: draft
description: "The implementer's agent, complexity tier and effort come from declared rules over derived facts, opt-in, with the strictest value winning and the reason recorded; a model routes nothing"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-08
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

The choice could be made by a capable model run before pickup, given
the issue and asked for a route, or by rules as data over facts the repository
already derives (the work type, the size and flag labels, the catalog's
flags and mandatory reviews), with defaults a repository overrides.

## Decision

A [route](../../GLOSSARY.md) (agent, complexity tier, effort) for the
implementer is derived by rules as data, as
[design/agent-routing.md](../../design/agent-routing.md) states them. One
of three [complexity tiers](../../GLOSSARY.md), simple, standard or
complex, comes from the item's work type, its size and the flags a
repository marks complex at any size (`routing.complex_flags`): a
configured flag sets the tier to complex. Each tier maps to a model per
runtime, the account's vendor choosing the runtime, with Claude's and
OpenAI's families built in (simple and standard on `sonnet` or `terra`,
complex on `opus` or `sol`) and every cell a repository setting. No
complexity tier maps the implementer to a Scout family (`haiku`, `luna`),
by default or by configuration. A repository may map a complexity tier to
a Judgment family (`fable`, `astra`); no default does, and the loader
accepts it as it accepts any configured model. One row
per work type gives the base effort, a closed list of raises moves the
effort up and never the tier, the strictest value wins on every conflict,
an underivable type takes the strictest row, an agent whose definition pins a
model keeps its pin against the rules, and a person's choice always wins,
field by field and forwarded explicitly so a pin cannot override it. The
route's reason, source and whether it was applied are written on the pull
request, the proposed route, the requested values and the effective ones
kept apart, where the review loop's report joins the effective route to how
the work went. Routing is
opt-in: a repository that declares no rules has its routes derived and
recorded, and nothing applied.

No model is asked to route, and no tier or model is written on an issue.
An agent may fill in a missing size or type facet, with a comment saying
why, and the rules derive the tier from it as from any other. The policy's own admission test for a judgment
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
  is a row a person moves with the records, not a step taken per item. A
  complex flag is such a row: a person lists it in `routing.complex_flags`,
  and it sets the tier for every item that carries it.
- **Two tiers named after M0's model tiers:** a route that named the
  model's cost class could not tell a mechanical task from a standard bug
  fix, and mapped to Claude's families alone; a complexity tier names the
  work, and the model per runtime is configuration.
- **An agent naming each item's model:** a choice no check reads, made
  again on every item; the agent that tends the queue fills a missing
  facet and the rules do the rest.
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
and a row in which a stricter complexity tier maps to a cheaper family
than a lighter one, from one families list in `plugin/shared/` that the
policy's mappings link. The audit's M0 criterion reads the `## Route` section of
recent pull requests as evidence beside the score.
