---
title: "ADR-0020: A Protocol chapter is generated from the code and agrees with it by a gate"
type: adr
status: draft
description: "Each contract Jig's parts and outside readers share has one chapter of the Jig Protocol, whose values are generated from the code's own tables and whose gate fails the build when the chapter and the code disagree; the chapter's authority is its gate, a stable chapter only grows within a plugin major version, and no specification is written by hand"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-13
owner: maintainers
decision_date: 2026-11-13
supersedes: ~
superseded_by: ~
tags: [adr, protocol, docs, generated-artifacts, plugin]
---

# ADR-0020: A Protocol chapter is generated from the code and agrees with it by a gate

**Status:** Draft · **Date:** 2026-11-13 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's parts never share a process, so they agree through contracts: a
drive's end states and exit codes, the records Jig writes, the labels and
hidden comment markers it reads, the commands a repository supplies.
Programs outside Jig's skills read the same contracts: the dispatch
dashboard's page, Jig's plugin for Orca, the planned hub, a repository's own
follow-up command, a second agent harness.

Each contract is defined once in code, as constants and typed shapes, and
restated by hand in several documents. Where a test ties a restatement to
the code (the drive's exit codes, the operator skill's commands) the copies
agree. Elsewhere they drift: the records inventory gave a record's envelope
version as one value where the records registry held another, and nothing
stopped it. No kind of document in
[docs/README.md](../README.md) could hold a statement of a contract to the
code: "Which document wins" let running code overrule a reference document,
so a wrong restatement was corrected only when someone noticed it.

The forces:

- **A reader outside the skills cannot correct a document.** A skill's
  agent may read the code when a document looks wrong; a dashboard page or
  another harness acts on what it was told.
- **Every hand-written copy drifts.** A specification written by hand would
  be one more copy, however carefully kept.
- **A contract still moves while its plan item is open.** Promising
  stability for it would be false; leaving it out would leave its readers
  with nothing.
- **Derived files cost** ([M2](../../modules/M2-generated-artifact-freshness/README.md)):
  a committed one can go stale and conflicts when two branches regenerate it.

## Decision

1. **The Jig Protocol is a kind of document of its own.** It is one chapter
   per contract, in `plugin/protocol/`, where an installed plugin carries it
   ([ADR-0002](ADR-0002-the-plugin-is-its-directory.md)).
2. **A chapter's values are generated from the code**, from the tables the
   code itself reads, through Jig's derived-files practice: an entry in the
   generated-file inventory, a regenerate command and a check
   `bun run gates` runs. Only the meaning (what each value is for and when it
   applies) and the chapter's prose are written by hand, and the meaning of
   each value is written in the code beside the value.
3. **The gate is the chapter's authority.** A chapter and the code must
   agree; the gate fails the build when they do not, and the disagreement
   is settled by regenerating the chapter, never by editing it to match.
4. **The Protocol ranks after terms and before reference** in "Which
   document wins". A reference document that restates a contract
   differently from its chapter is corrected to it, or made a link.
5. **A chapter is stable or provisional, and carries its own version.** A
   stable chapter only grows within one version: a value is withdrawn by
   keeping it as a tombstone, never deleted or reused, and a field is never
   removed or retyped; a change that breaks this raises the chapter's
   version, with a change note marked breaking. The gate holds this by
   comparing the chapter's data with the integration branch's. A
   provisional chapter names the plan item that still moves it, and
   becomes stable when that item is finished.
6. **No specification is written by hand**, and the word "spec" is not used
   for the Protocol: it means the spec a work item links.

How it works, the chapter list and the build order are in
[design/protocol.md](../../design/protocol.md).

## Alternatives considered

- **A specification written by hand, reviewed with each change.** Rejected:
  review misses a restatement as surely as it misses any other copy; the
  drift this decision answers happened under review.
- **Keep the restatements and add a consistency test per document**, as the
  drive's exit codes have. Kept for the few restatements a skill acts on in
  the middle of a step (held restatements); rejected as the whole answer,
  since every new document would need its own test and outside readers
  would still have no single statement to read.
- **Tie stability to the plugin's major version.** Rejected: the plugin's
  version moves for every change, and before its 1.0.0 a breaking change
  does not move the major version at all.
- **Generate the chapters at build time and commit nothing.** Rejected: an
  installed plugin, a skill's link and a program outside Jig read the
  chapters at rest, with no generator beside them.
- **A top-level `protocol/` directory.** Rejected: a skill's link to it
  would break on a machine that has only the plugin.
- **Generate code from the chapters.** Rejected: derivation runs one way,
  from the code, which is what runs.

## Consequences

- A reader outside the skills has one statement of each contract it can
  trust, and machine-readable data and schemas beside it.
- A change to a contract changes its chapter in the same pull request, and
  ships as a plugin version with a change note, which a contract change
  owed anyway.
- Code that defines a contract carries a `meaning` beside each value, and
  a type the schema generator cannot express is reshaped or left without a
  schema.
- A stable chapter constrains the code: a value cannot be deleted or reused
  without raising the chapter's version.
- The check reads the integration branch's history, so a clone too shallow
  to hold the merge base fails it until fetched.

## When to reopen

- A chapter's prose, which no gate holds, is found wrong more than rarely:
  more of it should move into the code's tables.
- Readers outside the skills find a version per chapter too fine, and ask
  for one version of the whole Protocol.
- The generated chapters conflict between branches often enough to cost
  more than the drift they prevent.

## Extraction (decisions-become-checks)

Not checkable until the generator is built. Then the generator's `--check`,
run by `bun run gates`, fails a chapter that differs from what the code
generates, a value without a meaning, a provisional chapter whose plan item
is not open, a stable one that names an item, and a stable chapter that
lost or changed a value the integration branch's copy holds without raising
its version. That the Protocol ranks where point 4
says is review's to hold.
