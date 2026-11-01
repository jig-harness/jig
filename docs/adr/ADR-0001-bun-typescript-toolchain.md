---
title: "ADR-0001: Bun and TypeScript for Jig's tooling and gates"
type: adr
status: amended
description: "Jig's runnable tooling, gates and skills are written in TypeScript and run with Bun"
lifecycle: permanent
version: "1.1"
last_updated: 2026-11-01
owner: maintainers
decision_date: 2026-10-04
supersedes: ~
superseded_by: ~
tags: [adr, toolchain]
---

# ADR-0001: Bun and TypeScript for Jig's tooling and gates

**Status:** Approved · **Date:** 2026-10-04 · **Deciders:** Jig's maintainers

## Context

Jig ships runnable tooling: the plugin's skills, the repository gates, the
module reference gates and machine-level tools. The people and agents who run
them work on macOS, Linux and Windows. The first gates were Bash scripts.
Bash runs on Windows only through a compatibility layer, and its standard
utilities (`sed`, `grep`, `date`, `stat`) take different options on macOS and
Linux, so a script that passes on one machine can fail on the next. The
skills also run from the plugin cache, a copy with no `node_modules`, so
they can depend only on what the runtime provides.

## Decision

Jig's runnable tooling and gates are written in TypeScript and run with
[Bun](../../GLOSSARY.md), pinned through mise (`mise.toml`). Scripts use
Bun's built-ins and the `node:` modules it provides; a skill that needs a
library vendors its single-file build. Bun is Jig's toolchain, not a
requirement on consumer repositories: tooling a repository in another
language runs ships as a standalone executable or runs under Jig's pinned
Bun through mise.

## Alternatives considered

- **Bash**: rejected; it does not run natively on Windows, and its utilities
  differ between macOS and Linux.
- **Node.js with npm**: rejected; Node runs TypeScript directly by stripping
  the types (by default since Node 22.18), but turning a script into a
  single-file executable takes extra packaging steps, which Bun has built in
  (`bun build --compile`), and Bun is one tool for running scripts and tests
  and installing dependencies.
- **Python**: rejected; turning a script into a single-file executable for a
  consumer repository needs extra packaging, which Bun has built in.

## Consequences

### Benefits

- One runtime runs the gates, the tests and the skills the same way on every
  operating system, so CI runs them on Linux, macOS and Windows.
- Type checking (`bun check`) and the ratchet cover all tooling.

### Costs

- Contributors and CI install Bun at the pinned version.
- A skill cannot install packages at run time; a dependency is vendored with
  its licence beside it ([plugin/AGENTS.md](../../plugin/AGENTS.md)).

## Extraction (decisions-become-checks)

Not mechanically checked. A gate forbidding new shell scripts outside
`seeds/` and test fixtures would check the first half of the decision.

## Amendments

### 2026-11-01 — A library with no single-file build is vendored as a bundle Jig builds (v1.1)

Touches the Decision's "a skill that needs a library vendors its single-file
build" and the Costs section's dependency line. Code that runs from the
plugin still depends only on Bun's built-ins and on code vendored beside it,
with its licence and its line in [NOTICE](../../NOTICE). A library that ships
a single-file build is vendored as that file, byte for byte, as js-yaml is. A
library that ships none, such as Optique, the parser the `jig` command line is
written with, is vendored as a bundle Jig builds from the pinned package with
Bun's bundler, unminified so a reader can follow it: a script in
`tools/plugin/` bundles an entry file that names only what the plugin
imports, and `tools/plugin/vendored.test.ts` and the generated-file check
rebuild the bundle and compare it with the vendored file byte for byte, so it
cannot drift from the pinned package or be edited by hand. Its declarations
name the package's own types, which the type check reads from the
repository's `node_modules`; nothing that runs reads them.

The bundle is what the pinned Bun writes for the pinned package, so a change
that updates either rebuilds it, and a Bun update can change a vendored file
whose library did not change. A bundle also carries the parts of the library
its entry reaches, not only the functions the plugin calls.
