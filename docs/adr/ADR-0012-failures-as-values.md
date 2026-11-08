---
title: "ADR-0012: Failures are values, and a throw is a defect"
type: adr
status: approved
description: "Plugin code returns an Outcome for a failure its caller handles; a throw is a bug, caught once at a boundary. Effect was weighed and declined, with the condition for reopening it"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-08
owner: maintainers
decision_date: 2026-11-02
supersedes: ~
superseded_by: ~
tags: [adr, errors, plugin]
---

# ADR-0012: Failures are values, and a throw is a defect

**Status:** Approved · **Date:** 2026-11-02 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's runnable code runs with nobody at the keyboard, so a failure has to
reach a receipt or a page as something a person can read, and a bug must not
stop the work around it. A caller can handle a failure only when it can see
from a signature that a call can fail and tell one failure from another
without reading a message; a thrown error with a module's own class shows
neither, and one forgotten catch stops everything around it.

## Decision

Code that can fail in a way its caller should handle returns an `Outcome`
([plugin/shared/outcome.ts](../../plugin/shared/outcome.ts)): the value, or a
failure with a stable `code` for code and tests, a plain-language `reason` for
a person, and the `cause` that was thrown, for a log. An I/O edge catches what
the platform throws into one. Anything that still throws is a defect, caught
once at a boundary and reported with its stack; one defect stops only what it
is inside. Neither the code nor the reason is parsed from the other.

Under `plugin/` this holds as follows:

- **The dispatcher and resource collection** (`plugin/dispatch/`,
  `plugin/gc/`) throw nothing but a `Defect`, the usage exit
  (`ExitError(USAGE_EXIT, …)`, exit 2, for a command the running copy
  refuses to run) and a rethrow of what a `catch` caught. Their defect
  boundaries are the dispatcher tick, each repository's turn in it, and
  each stage of that turn's `--apply` (its launch stages, its nudges, its
  notifications, its close), so a defect in one stage leaves the others'
  launches standing; and, in resource collection, the runner around each
  kind's inventory, proof and removal. A failed configuration read stops a
  collection run before it collects anything, and the run's receipt names
  the failure's code and reason.
- **The shared code and the `jig` command's runtime** (`plugin/shared/`,
  `plugin/runtime/`, `plugin/jig.ts`) return outcomes from the edges the
  dispatcher, resource collection and the lifecycle verbs call, such as the
  scheduler's reads and writes and the Orca port. A bug there is a
  `Defect`. A failure that still travels as a throw does so to a catch that
  handles it, in the skill scripts or inside these modules (the harness
  commands an upgrade runs, the scheduler's helpers, the collection locks),
  as an error class built on one base, `JigError`
  ([plugin/shared/outcome.ts](../../plugin/shared/outcome.ts)), which
  carries the same `code` and `cause` an outcome's failure does. The
  launcher keeps its own classes: earlier releases copy it out to run on
  its own, so it imports nothing of the plugin's.
- **The lifecycle verbs** report a component's failure as an outcome and
  exit with its code; a refused command line stays the usage exit.
- **The skill scripts** under `plugin/skills/` are not under the rule: they
  keep their own error handling, and bringing them under it is an item of
  its own.

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

- Two styles live side by side while the skill scripts keep their own
  error handling.
- A framework that expects rejected promises gets one adapter that turns a
  failure back into one.

## Extraction (decisions-become-checks)

[`scripts/check-throws.ts`](../../scripts/check-throws.ts), which `bun run
gates` runs, reads the syntax of every file under `plugin/dispatch/` and
`plugin/gc/` and fails on any `throw` that is not `throw new Defect(…)`,
`throw new ExitError(USAGE_EXIT, …)` or a rethrow of the enclosing `catch`
clause's binding. A defect boundary catches what is thrown; it does not
throw, so the boundaries need no exception of their own. The shared code,
the runtime and the skill scripts are outside its scope. It reads each
`throw` statement, not what runs: a rejected promise, a throw inside a
shared helper the code calls, an import renamed to `Defect` or a rethrow of
a shadowed binding pass it, and review catches those.
