---
title: "ADR-0012: Failures are values, and a throw is a defect"
type: adr
status: draft
description: "Plugin code returns an Outcome for a failure its caller handles; a throw is a bug, caught once at a boundary. Effect was weighed and declined, with the condition for reopening it"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-03
owner: maintainers
decision_date: 2026-11-02
supersedes: ~
superseded_by: ~
tags: [adr, errors, plugin]
---

# ADR-0012: Failures are values, and a throw is a defect

**Status:** Draft · **Date:** 2026-11-02 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's runnable code runs with nobody at the keyboard, so a failure has to
reach a receipt or a page as something a person can read, and a bug must not
stop the work around it. Today the dispatcher returns most failures as typed
results and turns each read's failure into a report record at its edge, while
garbage collection throws and stops. Each module has grown its own error
classes and its own shape for "this could not be done", so a caller has to
know which one it is holding.

## Decision

Code that can fail in a way its caller should handle returns an `Outcome`
([plugin/shared/outcome.ts](../../plugin/shared/outcome.ts)): the value, or a
failure with a stable `code` for code and tests, a plain-language `reason` for
a person, and the `cause` that was thrown, for a log. An I/O edge catches what
the platform throws into one. Anything that still throws is a defect, caught
once at a boundary and reported with its stack; one defect stops only what it
is inside. Neither the code nor the reason is parsed from the other.

The first code built on this is `jig dispatch dashboard`. Bringing the rest of
the plugin under the rule is open work: until then, code that throws today
keeps its behaviour.

## Alternatives considered

- **[Effect](https://effect.website/)**: typed error channels, structured
  concurrency and dependency layers in one library. Declined: the passes and
  implementers that write Jig's code are mostly models, which write plain
  TypeScript with catches at the edges reliably and Effect's generators and
  layers subtly wrong; Jig's readers are often new to the code; it ships no
  single-file build, so the plugin would vendor a bundle several times the size
  of its largest vendored library
  ([ADR-0001](ADR-0001-bun-typescript-toolchain.md)); and the existing tests
  assert today's shapes. **Reopen it** when Jig holds a resident process with
  real concurrency, where structured cancellation pays for all of that. A
  read-only server answering one database query per request is not one.
- **Keep throwing, with one error base class**: a caller still cannot see from
  a signature that a call can fail, and a forgotten catch stops a tick.

## Consequences

### Benefits

- A signature says what can fail, and the type check makes the caller look.
- A receipt or a page carries a code and a sentence, never a stack; the stack
  goes to the log.

### Costs

- Two styles live side by side until the rest of the plugin is brought under
  the rule.
- A framework that expects rejected promises gets one adapter that turns a
  failure back into one.

## Extraction (decisions-become-checks)

Not mechanically checked yet. A gate counting throws outside the defect
boundaries and the usage exit would check it once the plugin is under the rule.
