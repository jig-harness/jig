---
title: "ADR-0006: Jig is published from its own organization, with the copyright and the name held apart"
type: adr
status: approved
description: "The repository lives in the jig-harness organization; Docomply holds the copyright and licenses it under Apache-2.0; Van Code B.V. holds the name and logo and licenses them to the project; if Docomply can no longer carry the copyright the maintainer may take it, and if the name's holder can no longer act its licence to the project continues"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-18
owner: maintainers
decision_date: 2026-10-18
supersedes: ~
superseded_by: ~
tags: [adr, publishing, licence, brand]
---

# ADR-0006: Jig is published from its own organization, with the copyright and the name held apart

**Status:** Approved · **Date:** 2026-10-18 · **Deciders:** Jig's maintainer and Docomply

## Context

Jig was built by its maintainer as a founder of Docomply, and lived in
that company's GitHub organization while private. Publishing it raises
three questions a private repository never had to answer: where the
repository lives, who holds the copyright, and who holds the name. Naming
the copyright holder here is the one exception a person made to the rule
that Jig names no organization; nothing else about where Jig's practices
came from belongs in this record or anywhere else in Jig.

Three facts shape the answer. Apache-2.0 makes every published version
usable and forkable forever, so whoever holds the copyright cannot take the
code back; what a holder keeps is the power to license the original work
under other terms and, separately from the licence, the name. A
repository's address is what every consumer installs from, so a home tied
to one company's organization breaks every install if that organization
goes away. And work done by a founder for a company is normally that
company's, so a copyright notice in a person's name would be a cloud on the
company's title.

## Decision

- The repository lives in the `jig-harness` GitHub organization, which
  exists for Jig alone. It is administered by the maintainer, with a
  Docomply account as a second owner, so the home belongs to neither party's
  other business.
- Docomply holds the copyright in Jig's code and documents and licenses
  them under the Apache License 2.0, with the templates under MIT No
  Attribution. [NOTICE](../../NOTICE) names it. Contributions arrive under
  the Developer Certificate of Origin, without a contributor licence
  agreement, so no party can relicense the whole work later.
- The name Jig Harness, its short form Jig, the logo and the
  jig-harness.dev domain are held by Van Code B.V., the maintainer's company, and licensed to the project and to
  Docomply royalty-free for use with the code. [TRADEMARK.md](../../TRADEMARK.md)
  says what anyone may do with the name.
- If Docomply is dissolved, liquidated, becomes insolvent, or makes no
  release of Jig for twelve months, the maintainer has an option to take an
  assignment of the copyright for nominal consideration. If the name's
  holder can no longer act, the name's licence to the project continues.
  The written agreement between the parties holds the terms; this record
  states that they exist.

## Alternatives considered

- **Keep the repository in Docomply's organization**: rejected; the install
  address would name a company whose fate has nothing to do with the
  code's, and the no-origin-references rule would be contradicted by the
  address itself.
- **The maintainer holds the copyright personally**: rejected; the work was
  done for the company, and a personal notice would be a defect in the
  company's title that any due diligence would flag.
- **Docomply holds the name too**: rejected; the name is what a fork cannot
  take, so holding it apart is what lets the project keep its identity if
  the copyright holder's situation changes.
- **A contributor licence agreement**: rejected; it keeps relicensing open
  for a project that has no reason to relicense, at the cost of contributor
  friction.

## Consequences

### Benefits

- Every install address and link survives any change in either company.
- Docomply's title to the code is clean; the project's identity does not
  depend on it.
- Contributors know the licence will not change.

### Costs

- Two holders instead of one: a question about the name goes to one party,
  a question about the code to the other.
- The reversion terms live in a private agreement, which this record can
  only point to.

## Extraction (decisions-become-checks)

Partly checkable. `scripts/check-licences.ts` keeps NOTICE complete, and
`scripts/check-no-tracker-refs.ts` reads the licensor's name from NOTICE
and forbids it everywhere but the places its pattern file allows, this
record among them. The organization, the agreement and the reversion are
not mechanically checkable.
