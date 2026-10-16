---
release: minor
---

M15 Contracts and error handling, a practice module for the failures and interfaces that callers and stored data depend on.

### Added

- [M15 Contracts and error handling](../modules/M15-contracts-errors/README.md):
  a failure keeps its cause and travels on one of three declared channels (a
  result type for an expected outcome, a typed domain error with a registered
  code across a module boundary, one defect primitive for a bug), callers
  branch on type or code and never on message text, errors reach callers
  through one boundary with a fixed response shape that sends no internal
  detail on a server-side failure, and telemetry is keyed on code and type.
  With a copyable error contract
  ([`templates/ERROR-HANDLING.md`](../modules/M15-contracts-errors/templates/ERROR-HANDLING.md)),
  a detached-work helper and unhandled-rejection listener
  ([`reference/detached/`](../modules/M15-contracts-errors/reference/detached/)),
  and the lint rules below.
- The GritQL rules against swallowing a failure (a default-returning catch,
  discarded child error output, an unchecked parse cast) are now the module's
  reference lint rules
  ([`reference/lint-rules/`](../modules/M15-contracts-errors/reference/lint-rules/)),
  joined by two more: a thrown native error outside the typed family, and a
  branch on an error's message text. Jig runs all of them on its own code
  under the ratchet.
- One error-code registry as the single source of truth: every code declared
  once with its metadata, every other copy generated under M2's freshness
  triad, no code constructed elsewhere, and the registry and the code audited
  both ways. A neutral template registry
  ([`templates/error-codes.yaml`](../modules/M15-contracts-errors/templates/error-codes.yaml))
  and two gates with fixtures and a self-test
  ([`reference/error-registry/`](../modules/M15-contracts-errors/reference/error-registry/)):
  no inline code outside the registry, with an allowlist by identity; orphans
  against a baseline by identity, and reverse orphans in hand-written
  documents.
- Migration discipline: a merged migration is never edited, renamed or
  deleted (held at merge time by a gate over the diff against the merge base,
  and at apply time by the runner's hash), the ledger and the files match one
  to one in strictly increasing order, a migration changes structure only
  with a data change's exception in an allowlist outside the file, and a
  migration's commit carries M1's review marker. A copyable contract
  ([`templates/MIGRATIONS.md`](../modules/M15-contracts-errors/templates/MIGRATIONS.md)),
  the merge-time gate with a self-test over scratch repositories
  ([`reference/migration-immutability/`](../modules/M15-contracts-errors/reference/migration-immutability/)),
  and mappings per migration tool and database parser.
- Published interface surface: an operation is internal unless a named
  external consumer justifies publishing it, with the published and the
  internal contract documents generated from one source; every request input
  declares a bound, and the count of unbounded fields only falls; an
  operation declares every failure status its code can produce. A copyable
  policy ([`templates/INTERFACE-SURFACE.md`](../modules/M15-contracts-errors/templates/INTERFACE-SURFACE.md))
  and two gates over the contract document with fixtures and a self-test
  ([`reference/interface-surface/`](../modules/M15-contracts-errors/reference/interface-surface/)):
  no internal operation in the published document, and the unbounded-input
  count held against the merge base or a ceiling.
- M15's criteria at Lite, Standard and Strict in the audit
  (`since: next`), the module's targets in the Team/Standard and
  Regulated/Strict profiles, its place in the survey map, and its scores in
  Jig's own record and the calibration record. Glossary entries for the
  module's terms: failure channel, result type, domain error, defect, error
  boundary, correlation id, detached work, error-code registry, orphan code,
  migration ledger, fix forward, structure-only migration, published
  interface, bounded input.
- The `review` skill's contract tier asks, for an operation a change adds to
  the published contract, who its external consumer is, that every input it
  declares carries a bound, and that its declared failure statuses cover what
  its handler and the error boundary can produce.
- A shared GritQL fixture harness (`lib/test-helpers/grit-fixtures.ts`) that
  runs a directory of rules against its `good`/`bad` fixtures, used by Jig's
  own rules and the module's.

### Changed

- M1's ratchet names a Biome plugin by its file rather than its path, so a
  rule moved to another directory under the same name keeps its strictness
  and is not reported as a loosening.
- M1's gate-authoring example and its commit-msg marker reference point at
  M15's migration discipline for the migration rules; M2's README points at
  M15 for the registry practice an error-code catalog is generated from.
