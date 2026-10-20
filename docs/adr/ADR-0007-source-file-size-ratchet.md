---
title: "ADR-0007: Ratchet source file size at 1,000 lines"
type: adr
status: draft
description: "Count excess source and test lines through the existing M1 ratchet, and split files in the source"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-20
owner: maintainers
decision_date: 2026-10-20
supersedes: ~
superseded_by: ~
tags: [adr, quality]
---

# ADR-0007: Ratchet source file size at 1,000 lines

**Status:** Draft · **Date:** 2026-10-20 · **Deciders:** Jig's maintainers through pull-request review

## Context

Large source files are difficult to read in one context, make review less
reliable, and concentrate conflicts between concurrent changes. The same
problem affects test suites. Existing excess cannot all be removed at once,
but allowing it to grow makes each later split harder.

## Decision

Jig uses its existing [M1 ratchet](../../modules/M1-gates-enforcement-ladder/reference/ratchet/README.md)
to count source and test lines above 1,000 per file. The threshold is the same
for tests and production code because both need reviewable units. The count
is the sum of excess lines, rather than the number of oversized files: a
split into smaller files can reduce debt even before the last large file is
gone. Prose, vendored libraries and generated artifacts are outside this
counter's source scope.

Split files in the maintained source along responsibilities or tested
behaviors, with shared fixtures in helper modules. Preserve executable paths
that skills invoke. A build-time transformation would leave the maintained
source difficult to change and would not solve the problem.

The threshold is an example of Jig's own configuration, not a requirement
that every consumer adopt the same number. Raising it is a loosening and
requires a person to request the existing `Ratchet-Loosen` acknowledgement;
lowering it is a tightening.

## Alternatives considered

- **Biome's file-length rule:** emits one finding per oversized file, which
  would not count additional growth within a file already above the limit.
  Fallow's unit-size measure concerns functions; its file-size option skips
  large inputs rather than reporting their excess lines.
- **A separate file-size gate:** duplicates the existing ratchet's merge-base
  comparison, reporting and loosening checks.
- **Count oversized files:** allows an already oversized file to grow without
  changing the count, and penalizes intermediate splits that reduce excess.
- **Block every existing violation immediately:** prevents unrelated changes
  until all historical files are split.

## Consequences

The gate prevents an increase in total excess lines and allows existing
excess to fall incrementally. This aggregate rule permits growth in one
oversized file when another shrinks by at least as much; review must still
check that a split follows meaningful boundaries. The limit is a review aid,
not proof that the code is simple.

## Extraction (decisions-become-checks)

The file-size counter in [the ratchet wiring](../../tools/quality/ratchet.jsonc)
and its self-tests enforce excess growth and threshold loosening. This
repository has no separate decision-rules catalog; the executable counter
is the enforcement mechanism.
