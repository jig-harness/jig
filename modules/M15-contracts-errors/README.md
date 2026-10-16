# M15 — Contracts and error handling

**What problem this solves.** A system's callers, its stored data and its
own modules depend on contracts that nothing checks by default, and the
quietest breakage is in error handling. A `catch` that returns `null` turns
a failed network call into "no result", and whoever debugs it an hour later
finds an empty list, not the failure. A child process runs with its error
output discarded, so when it fails the reason it printed is gone. One module
signals "not found" by returning `undefined`, the next by throwing a plain
`Error`, a third by returning `{ success: false }`, and a caller that needs
to react to "not found" ends up testing the error's message text, which
breaks the day someone rewords it. At the edge of the system an unexpected
error reaches the caller as a stack trace with an internal path, a secret's
name or another account's identifier in it. Each of these passes every test
and surfaces as an incident. This module states the contract: a failure
keeps its cause and travels on one of three declared channels, callers
branch on its type or code, and errors reach the outside through one
boundary with a fixed, safe shape. The contracts that stored data and
published interfaces depend on (one registry of error codes, migrations that
never change once applied, an interface that is internal by default) are the
module's other pieces; see [Status](#status).

## Invariant

> A failure is either propagated or reported with its original cause
> attached; no code path turns an error into a default value, an empty
> result or silence. Every failure travels on one of three **failure
> channels**: an expected outcome the caller branches on is returned as the
> one **result type**, a failure that crosses a module boundary is thrown as
> a typed **domain error** carrying a registered code, and a bug or broken
> invariant is raised through one **defect** primitive. Callers branch on
> type or code, never on message text. Errors reach callers only through one
> **error boundary** that maps them to a fixed response shape, and nothing
> internal leaves it on a server-side failure.

Each piece below is a tool-independent rule; the tools that implement it in
each ecosystem are in [mappings.md](mappings.md). Terms in bold are defined
in the [glossary](../../GLOSSARY.md).

## Core pieces

1. **Never swallow, keep the cause.** A failure is either propagated to the
   caller or reported with its original cause attached. No code path turns
   an error into a default value, an empty result or silence: not a `catch`
   that returns `null`, not a child process run with its error output
   discarded, not a parsed input cast to the type it is hoped to have, not an
   empty `.catch()`. Wrapping is fine, and often right, as long as the
   wrapper carries the original as its cause: the wrapper's message ("query
   failed") hides the fault its cause names. Work that nobody awaits,
   [detached work](../../GLOSSARY.md), fails where nothing is listening, so
   it goes through one helper that reports a failure with its cause and never
   rejects; [`reference/detached/`](reference/detached/) is one. Each
   long-running entry point installs one process-level listener for
   unhandled rejections that reports them the same way, falls back to
   standard error when the logger itself fails, and never throws. The
   entry point runs in the runtime mode where that listener handles the
   rejection rather than one that exits first
   ([mappings.md](mappings.md#detached-work-and-unhandled-rejections) names
   the mode and its settings per runtime). With the listener in place the
   process no longer stops on an unhandled rejection, so the fix for a
   reported one is to route that work through the helper, never to remove
   the listener. The syntactic half of this rule is a lint:
   [`reference/lint-rules/`](reference/lint-rules/) flags the
   default-returning catch, the discarded error output and the unchecked
   cast.
2. **Three failure channels.** Every failure travels on one of three
   [failure channels](../../GLOSSARY.md), and which one is a rule, not a
   taste:

   | Situation | Channel |
   |-----------|---------|
   | An expected outcome the caller branches on: a parse that can fail, a lease not acquired, a record not ready | returned as the one [result type](../../GLOSSARY.md): a tagged union of a success arm and an error arm whose error carries a tag |
   | A failure that crosses a module boundary, expected or not: not found, forbidden, a conflict, an upstream unavailable | thrown as a [domain error](../../GLOSSARY.md): a typed error carrying a registered code and the metadata the code declares (severity, message key, recovery hint) |
   | A bug or a broken invariant | raised through one [defect](../../GLOSSARY.md) primitive (`invariant(condition, message)` or a defect error type), so "defect" is a mechanical property rather than an author's judgment; it maps to a generic server-side failure and is never caught to drive control flow |

   One result type, not several: a repository with `{ success }` here,
   `{ ok }` there and an `outcome` union elsewhere has three channels for one
   thing, and callers handle each differently. The error arm's tag is derived
   from the domain error's code, not written by hand beside it, so there is
   no third discriminant to keep in step. A thrown native error
   (`throw new Error(...)`) is on no channel: it carries neither type nor
   code, so a caller can only read its message. A module that cannot import
   the shared domain error (a leaf package the shared one depends on) keeps
   its own tagged error family, and the adapter that calls it converts that
   family into domain errors at the call boundary; the family never reaches a
   route. A failure inside a database transaction aborts it: the transaction
   rolls back, and none of its partial work commits. The failure therefore
   leaves the transaction through its rollback path, never as a value the
   transaction's mechanism reads as success
   ([mappings.md](mappings.md#failure-channels) names that path per tool).
   Conversion between the channels happens outside the transaction.
3. **Branch on type or code, never on message text.** The message is for
   people. A caller branches on the error's type (`instanceof`), its code or
   its tag; a test of `err.message` (`startsWith`, `includes`, equality, a
   regular expression) breaks when the text is reworded or translated, and
   on the wire the message is a key for localization, not a sentence. The
   lint in [`reference/lint-rules/`](reference/lint-rules/) catches the forms
   it can see; review catches the rest.
4. **One error boundary.** Errors reach callers only through one
   [error boundary](../../GLOSSARY.md): an error-handler plugin on a web
   server, the exit-code boundary of a command-line tool. It maps each error
   to a fixed response shape: a code, a message key, a severity, a recovery
   hint and a [correlation id](../../GLOSSARY.md), which together are the
   complete public field set, plus, when the failure is the caller's (a
   4xx), structured details such as field errors. An error
   the boundary does not know (not a domain error, not one of the framework
   errors it enumerates) becomes an opaque generic code with a server-side
   status. Nothing "error-shaped" is trusted by its shape: a look-alike can
   pass a guard and still carry an unregistered code and status onto the
   wire, so the boundary asks for the registered type. On a server-side
   failure (5xx) no internal detail is sent at all: no exception text, no
   stack, no cause, no query text, no file path, no interpolated template,
   no identifier; the body holds the public field set and nothing more. The
   detail is logged through an allowlist of keys known to be safe, and the
   correlation id is what support uses to find it. A system with no network
   transport and no codes (a command-line tool) writes the same rule in its
   own shape: an exit status per outcome and one line on standard error,
   with an unknown error mapped to the generic failure status. A route
   never builds an error response by hand, and never returns a result
   type's error arm as a success body: it maps every error arm,
   exhaustively, to a thrown domain error.
5. **Telemetry keyed on code and type.** Error metrics and span attributes
   are keyed on the error's code and its type (the class name), never its
   message: a message as a metric label or a span attribute is unbounded
   cardinality and a leak of whatever the message interpolated. A
   structured log carries the same code and type as its fields, and may
   also carry diagnostic detail (the message and the cause chain) for the
   person debugging, but only through redaction: the allowlist of keys the
   boundary logs through, with secrets and identifiers masked, and never as
   a field anything aggregates on. An expected failure returned as a
   result arm is recorded as an outcome of the operation, not as an error,
   so a dashboard tells "the parse said no" from "the service broke".
   [M11](../M11-process-observability/README.md) measures the delivery
   process the same way, by typed events and never by log text.
6. **One error-code registry.** Every code a system can emit is declared
   once, in one [error-code registry](../../GLOSSARY.md), with its metadata
   (severity, message key, recovery hint, transport status) and in one
   declared format. Everything else that names codes is a
   [generated artifact](../../GLOSSARY.md) of the registry, never a second
   declaration: the client's exhaustive code union (so a `switch` over the
   codes narrows to `never`, and a new code fails the client's build until
   it is handled), each locale's message catalog, and the public error
   reference. Each copy carries [M2's](../M2-generated-artifact-freshness/README.md)
   freshness triad, and its drift check regenerates through the generator's
   own function and compares the whole text, so there is no second
   recognizer to drift. The catalog generator owns the catalog's structure,
   not its words: it keeps every authored entry byte for byte, inserts a
   visible placeholder for a registered code that has no entry yet, and
   drops the entry of a code no longer registered; the check fails on any
   difference and on a placeholder, in the change or already merged, so a
   code minted without its message in every locale fails CI. No code is
   constructed outside the registry: the strongest form is visibility, a
   constructor the registry's module does not export; where the language
   cannot hide it, a gate rejects the constructor elsewhere
   ([`reference/error-registry/`](reference/error-registry/)), over every
   package that depends on the error module, a set derived from the
   dependency graph rather than listed by hand. The gate's allowlist is
   kept at zero, and while debt remains it is listed by identity (the file
   and the code), checked for exact equality, never as a count: a count
   stays the same when one construction is fixed and another added. The
   registry and the code that throws must agree both ways, so an audit
   reports [orphans](../../GLOSSARY.md), registered codes nothing references,
   against a baseline by identity, and [reverse orphans](../../GLOSSARY.md),
   code-shaped literals in hand-written documents that no registry declares:
   a generated reference cannot hold one, a hand-written page can. M2 leaves
   the error-code catalog out of its worked examples because its values are
   domain-bound; this piece is the mechanism without the values, and
   [`templates/error-codes.yaml`](templates/error-codes.yaml) holds neutral
   ones.
7. **Migration discipline.** The structure a system stores its data in
   changes through migrations, and three contracts hold them. *Immutable
   once merged.* A migration that has merged is never edited, renamed or
   deleted; a wrong one is corrected by a new one
   ([fix forward](../../GLOSSARY.md)). The rule is held twice, because each
   half misses what the other catches. At merge time a gate diffs the
   migrations directory against the merge base and fails on a modified,
   renamed or deleted file, allowing one thing: a restoration to content the
   file held before on the base branch, which repairs an earlier illegal
   edit ([`reference/migration-immutability/`](reference/migration-immutability/)).
   At apply time the runner records each file's hash when it applies it and
   refuses to run while an applied file's hash differs or its file is gone,
   so an edit that slipped past the gate stops before the next migration
   runs, not after; a tool whose runner records no hash gets one in the
   repository's own wrapper. *Ledger integrity.* The
   [migration ledger](../../GLOSSARY.md), the record of what exists to apply
   (a journal file, a changelog, a revision chain), and the files match one
   to one, in strictly increasing order with no gap in the sequence, and
   each entry spells out every field the runner reads. A runner that applies
   "everything after the last applied" silently skips an entry whose order
   key is behind the latest; a file with no entry never runs, and an entry
   with no file fails the deploy at the one moment it matters. *Structure
   only.* A migration changes structure (tables, columns, indexes,
   constraints, functions, policies), never data: a data change is a
   backfill with a runtime, a lock and a rollback story of its own, and
   belongs in a seed, a job or a reviewed one-off. The check parses the SQL
   grammar and walks the statement tree, so an `INSERT` inside a `WITH`
   query, a `DO` block or a function body is found, where a regular
   expression over the text finds the shapes its author thought of; a
   statement built dynamically at run time, which no parser can read, fails
   the file closed rather than reading as clean. A data change that must
   ride in a migration needs a reviewed allowlist entry outside the file,
   bound to the statement's identity, because an applied file cannot gain a
   marker later. *Mandatory review.* A migration's commit carries a review
   marker that a commit-msg hook checks and CI re-checks;
   [M1's commit-msg marker](../M1-gates-enforcement-ladder/reference/commit-msg-marker/)
   is that mechanism, with a migration review as its default example. Which
   runners record a hash, which skip silently and which parser reads each
   database's grammar are in [mappings.md](mappings.md#migration-discipline);
   [`templates/MIGRATIONS.md`](templates/MIGRATIONS.md) is the contract to
   keep beside the migrations.

8. **Published interface surface.** Three contracts hold the interface a
   system serves. *Internal by default.* An operation is internal unless a
   named external consumer justifies publishing it: a published operation
   is a commitment to its shape for as long as anyone integrates against
   it, un-publishing one costs a deprecation cycle and a migration window,
   while marking one internal is reversible the day a consumer asks. Each
   operation is marked once, at its source (a tag suffix, an extension
   field, a path prefix), and one generator writes two documents from that
   source: the [published interface](../../GLOSSARY.md), without the marked
   operations, and the internal one, with only them. A gate reads the
   published document and fails on any mark of the internal kind
   ([`reference/interface-surface/`](reference/interface-surface/)). A
   change that publishes an operation answers three questions where the
   reviewer reads them: who the external consumer is (a named role or
   system, not a future one), what they get that they cannot get another
   way, and why now; "someone might want it", "its sibling is public" and
   "it would be inconsistent otherwise" do not answer them, and the
   reviewer's default is "internal until a consumer asks". *Bounded
   inputs.* Every request input field declares a bound in the contract: a
   maximum length, a pattern or a format on a string, a maximum on a
   number, a maximum item count on an array, a closed shape on an object,
   a type on everything. A field with no bound accepts whatever a caller
   sends, and what the interface accepts the system stores, indexes, logs
   and forwards; a bound in the contract is one the validator enforces and
   the consumer reads. A named schema per kind of value (a name, a short
   text, a search query, an address) carries its bound once, so a bare
   `string` in a request stands out. A contract already carrying unbounded
   fields does not become clean in one change, so their count is held under
   [M1's ratchet](../M1-gates-enforcement-ladder/reference/ratchet/README.md):
   measured over the contract document, not the route source, since a
   declaration split across lines or built from a spread is one node in the
   document and a hole in a text scan; it may fall, never rise, and a field
   unbounded on purpose carries its reason beside it in the document. *Declared
   failure statuses.* An operation's declared failure responses name every
   status its code can produce: the boundary's generic server-side failure,
   the validation failure, the authentication and authorization refusals
   where those layers run, and the transport status of each domain error
   the handler throws, which the error-code registry already holds. A
   generated client then handles what can arrive, and a status the contract
   does not declare is a finding in review, not a surprise in production.
   The forms of the mark, the bound and the status list per contract
   technology are in [mappings.md](mappings.md#published-interface-surface);
   [`templates/INTERFACE-SURFACE.md`](templates/INTERFACE-SURFACE.md) is
   the policy to keep beside the contract.

## Maturity levels

- **Lite** — the error contract is written where agents and people read it
  (the three channels, never swallow and keep the cause, branch on type or
  code, the transaction rule, the boundary), the typed error family with
  codes exists, and the codes are declared once in one registry, in one
  format; where the repository has database migrations, the migration
  discipline is written beside them (immutable once merged, structure
  only, the ledger entry each needs, the review marker); where it serves
  an interface, the interface policy is written beside the contract
  (internal by default, the consumer question, a bound on every input,
  the failure statuses declared); enforcement may be convention.
- **Standard** — a lint rejects the swallowing forms (a default-returning
  catch, discarded error output, an unchecked cast), blocking in CI directly
  or under a ratchet; errors reach callers through one boundary with the
  fixed shape; a test proves a server-side failure carries no internal
  detail; detached work goes through one reporting helper and each entry
  point installs the unhandled-rejection listener; every other copy of the
  codes is generated from the registry and drift-gated, a code without its
  message in a locale fails CI, and a gate rejects a code constructed
  outside the registry; a merge-time gate rejects an edit, rename or
  deletion of a merged migration, the runner refuses an applied file
  whose hash changed, and a check holds the ledger and the files one to
  one in strictly increasing order; the published and the internal
  contract documents are generated from one source and a gate fails an
  internal operation in the published one, and the count of unbounded
  request inputs runs under the ratchet.
- **Strict** — lint rules reject a thrown native error outside the typed
  family and the defect primitive, and a branch on message text; error
  telemetry is keyed on code and type, with an outcome dimension for result
  arms, and structured logs carry a message or a cause chain only through
  redaction; an audit reports orphans against a baseline by identity, and
  reverse orphans in hand-written documents; a parser-based check rejects
  a data change in a migration, with its allowlist outside the files; the
  count of unbounded request inputs is zero, and each operation's declared
  failure statuses are checked in review against the codes its handler
  throws.

Some criteria are **expected-absent** by shape: a library or a command-line
tool serves no network interface, so the server-side-detail rule has nothing
to apply to, a repository whose lint rejects un-awaited promises and has
no detached work has nothing to route, one with no database has no
migrations to hold, one that reports failures to no caller beyond an exit
status or a thrown typed error (a library, a command-line tool) emits no
codes, so it has no registry to hold, no constructor to keep out of reach
and no orphans to audit, and its boundary writes an exit status rather than
a coded response, and one that serves no interface (a
library, a command-line tool, a static site) has no surface to publish or
bound. The
[audit](../../plugin/skills/audit/README.md) calibrates by repository shape.

## Adoption steps

1. Copy [`templates/ERROR-HANDLING.md`](templates/ERROR-HANDLING.md) into
   your docs tree, fill in the typed error, its code format, the boundary and
   the three channels, and point your instruction file at it. Define the
   domain error base with a code and the defect primitive, and derive the
   result type's tag from the code. Declare the codes once, in one registry
   ([`templates/error-codes.yaml`](templates/error-codes.yaml), or a code
   module with the same fields). Where you have database migrations, copy
   [`templates/MIGRATIONS.md`](templates/MIGRATIONS.md) beside them and fill
   in the format, the ledger entry and the review marker. Where you serve
   an interface, copy [`templates/INTERFACE-SURFACE.md`](templates/INTERFACE-SURFACE.md)
   beside the contract and fill in the mark, the named schemas and the
   consumer question. This is **Lite**.
2. Wire the three swallowing rules ([`reference/lint-rules/`](reference/lint-rules/),
   or the ecosystem's equivalents in [mappings.md](mappings.md)) under
   [M1's ratchet](../M1-gates-enforcement-ladder/reference/ratchet/README.md);
   keep the cause in every wrapper the fixes introduce.
3. Put one error boundary in front of every transport; map an unknown error
   to the generic code; strip every detail on a server-side failure and log
   it through an allowlist; write the test that sends an unknown error and
   asserts that the body holds the public field set (code, message key,
   severity, recovery hint, correlation id) with the generic code, and that
   no internal detail (stack, cause, query text, file path, the internal
   message) is in it.
4. Route detached work through the helper
   ([`reference/detached/`](reference/detached/)) and install the listener
   in each entry point, run in the runtime's default mode for unhandled
   rejections.
5. Generate every other copy of the codes from the registry under
   [M2's](../M2-generated-artifact-freshness/README.md) triad, with the
   catalog check failing on a placeholder; keep the constructor out of
   reach, or gate it
   ([`reference/error-registry/check-no-inline-codes.ts`](reference/error-registry/))
   with the allowlist at zero.
6. Where you have migrations, run the merge-time gate
   ([`reference/migration-immutability/`](reference/migration-immutability/))
   in CI and pre-push against the branch the work merges into, turn on the
   runner's hash check or add one in your wrapper
   ([mappings.md](mappings.md#migration-discipline) says which runners have
   none), write the ledger check for your tool's ledger, and set
   [M1's commit-msg marker](../M1-gates-enforcement-ladder/reference/commit-msg-marker/)
   on the migrations directory. Where you serve an interface, mark each
   internal operation at its source, have the generator write the
   published and the internal documents from it, and run both gates of
   [`reference/interface-surface/`](reference/interface-surface/) in CI:
   the internal check over the published document, the unbounded-input
   count against the base branch. This is **Standard**.
7. Add the two Strict rules (a thrown native error, a branch on message
   text) under the ratchet, excluding the typed family's module and the
   defect primitive by path; promote each to an error when its count reaches
   zero.
8. Key error telemetry on code and type, and record a result arm as an
   outcome. Run the orphan audit
   ([`reference/error-registry/audit-error-codes.ts`](reference/error-registry/))
   in CI, over the hand-written documents too, with a baseline by identity.
   Add the structure-only check over the migrations through your database's
   parser, with its allowlist outside the files and empty. Bring the
   unbounded-input count to zero and hold it there (`--max 0`), and have
   the review check each operation's declared failure statuses against
   the codes its handler throws. This is **Strict**.

## Status

### What the module provides

| Piece | What it is |
|-------|------------|
| [`templates/ERROR-HANDLING.md`](templates/ERROR-HANDLING.md) | A copyable error contract: the channels, the rules, the boundary's shape, the telemetry keys and the checks that hold them |
| [`reference/lint-rules/`](reference/lint-rules/) | GritQL rules for Biome with fixtures and a self-test: a default-returning catch, discarded child error output, an unchecked parse cast, a thrown native error, a branch on message text |
| [`reference/detached/`](reference/detached/) | The detached-work helper and the unhandled-rejection listener, with a self-test |
| [`templates/error-codes.yaml`](templates/error-codes.yaml) | A neutral error-code registry as data: the code format, the copies generated from it with their commands, and each code's metadata |
| [`reference/error-registry/`](reference/error-registry/) | Two gates with fixtures and a self-test: no code constructed outside the registry, with an allowlist by identity; and the audit for orphans, against a baseline by identity, and reverse orphans in hand-written documents |
| [`templates/MIGRATIONS.md`](templates/MIGRATIONS.md) | A copyable migration contract to keep beside the migrations: the file format, the ledger entry, the rules (immutable once merged, structure only, ledger integrity, mandatory review) and the checks that hold them |
| [`reference/migration-immutability/`](reference/migration-immutability/) | The merge-time gate against an edit, rename or deletion of a merged migration, allowing a restoration to a prior state, with fixtures and a self-test over scratch repositories |
| [`templates/INTERFACE-SURFACE.md`](templates/INTERFACE-SURFACE.md) | A copyable interface policy to keep beside the contract: internal by default with the consumer question, the mark and the two documents, the named schemas and their bounds, the failure statuses, the checks |
| [`reference/interface-surface/`](reference/interface-surface/) | Two gates over the contract document with fixtures and a self-test: no internal operation in the published document, and the count of unbounded request inputs held against the merge base or a ceiling |
| [`mappings.md`](mappings.md) | Per language: cause-keeping, result types, typed errors and defect primitives, the boundary per framework, detached work, telemetry keys; per migration tool: the ledger, the hash at apply, the parser per database; per contract technology: the visibility mark, the two documents, the bounds, the status list |
| [maturity criteria](../../plugin/skills/audit/criteria/M15-contracts-errors.yaml) | The criteria the [audit skill](../../plugin/skills/audit/README.md) scores |

Jig runs these rules on its own code under the ratchet
(`biome.json` and `tools/quality/ratchet.jsonc`); its scripts' exit-code
boundary is [`lib/cli.ts`](../../lib/cli.ts).

### Left out by design

- **A result type as reference code.** The type is five lines in any
  language and the helpers around it are a taste; [mappings.md](mappings.md#failure-channels)
  names the hand-rolled shape and the libraries per ecosystem instead.
- **Retry and resilience.** A domain error's recovery hint says what a
  caller may do; how a service retries is its own policy, not this module's.
- **The wording of messages and their translation.** The module fixes that
  the message is a key on the wire, not what the key says.
- **A ledger check and a structure-only scanner as reference code.** The
  ledger's format is each tool's (a journal file, a changelog, a revision
  chain) and the structure check needs the database's own grammar;
  [mappings.md](mappings.md#migration-discipline) names the check per tool
  and the parser per database.
- **Row-level security, role grants, vendor-bound objects and
  per-environment schema names in migrations.** Each is a policy of one
  database and one deployment, not a contract a caller depends on.
- **A library's export surface.** The interface rules are for an interface
  a system serves to callers over a transport; what a package exports is
  its own versioning's concern.

### Future

- **A checker for declared failure statuses**: a comparison of each
  operation's declared failure responses with the statuses its handler can
  produce (the boundary's, the validator's, the registry's for each code it
  throws). The rule is doctrine and a review lens until a checker has
  settled on how it reads the handler.
- **A rule against a second error family**: `class X extends Error` outside
  the typed family's own module, so a look-alike cannot grow beside it.
