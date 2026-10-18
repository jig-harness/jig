# Error handling

> Copy this into your repository (e.g. `docs/development/error-handling.md`),
> fill in the placeholders, delete what does not apply, and point your agent
> instruction file at it. It is the tool-independent contract from Jig's
> [M15 contracts and error handling](https://github.com/jig-harness/jig/blob/main/modules/M15-contracts-errors/README.md);
> the tools for each rule, per language and framework, are in its
> [mappings](https://github.com/jig-harness/jig/blob/main/modules/M15-contracts-errors/mappings.md).
> Terms are defined in Jig's
> [glossary](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).

## The typed error

Every failure that crosses a module boundary is a `<DomainError>` (in
`<src/errors/domain-error.ts>`) carrying a registered code. A code is
`<PREFIX-NNN>`; its metadata is declared once, beside the code, and read by
the boundary and the telemetry:

| Field | What it is | Example |
|-------|------------|---------|
| `code` | the registered code; the error's tag in a result type is derived from it | `<ORDERS-004>` |
| `messageKey` | the key of the message shown to a person; never a sentence | `<errors.orders.notFound>` |
| `severity` | `<info \| warning \| error \| fatal>` | `<error>` |
| `recovery` | what the caller may do: `<retry \| reauthenticate \| contact-support \| none>` | `<none>` |
| `status` | the status the boundary writes for this code on `<HTTP / gRPC>` | `<404>` |

Every code is declared once, in the registry `<src/errors/registry/>` (the
data form is Jig's
[`error-codes.yaml`](https://github.com/jig-harness/jig/blob/main/modules/M15-contracts-errors/templates/error-codes.yaml)),
and nowhere else; the client's code union
(`<packages/client/src/error-codes.generated.ts>`), each locale's message
catalog (`<apps/web/messages/<locale>/errors.json>`) and the public reference
(`<docs/reference/error-codes.md>`) are generated from it and never edited.

A bug or a broken invariant is raised through `<invariant(condition, message)>`
in `<src/errors/defect.ts>`, which throws `<DefectError>`; nothing else throws
without a code. A module that cannot import `<DomainError>` keeps its own
tagged error family, and the adapter that calls it converts that family into
domain errors at the call boundary.

## The three channels

| Situation | Channel |
|-----------|---------|
| An expected outcome the caller branches on (a parse that can fail, a lease not acquired, a record not ready) | return `<Result<T, E>>` from `<src/result.ts>`: `{ ok: true, value }` or `{ ok: false, error }` where `error` carries a tag |
| A failure at a module boundary, expected or not (not found, forbidden, a conflict, an upstream unavailable) | throw a `<DomainError>` with a registered code |
| A bug or a broken invariant | `<invariant()>` / `<DefectError>`; never caught to drive control flow |

A failure inside `<db.transaction(...)>` aborts it: the transaction rolls
back and none of its partial work commits. `<db.transaction(...)>` rolls
back when `<its callback throws>` and commits when `<it returns>`, so inside
it a failure `<is thrown, never returned as an error arm>`. Conversion
between the channels happens outside the transaction.

## Rules for every failure

1. **Never swallow, keep the cause.** A failure is propagated or reported
   with its original cause attached. No `catch` returns a default, no child
   process runs with its error output discarded, no parsed input is cast to
   the type it is hoped to have, no `.catch()` is empty. A wrapper carries
   the original as its `cause` and says what was being done; the cause says
   what went wrong.
2. **Branch on type or code, never on message text.** `instanceof`, `code`
   or the result's tag; never `message.includes(...)`, equality or a regular
   expression on the message. The message is for people and, on the wire,
   a key.
3. **Detached work goes through `<runDetached>`** (in
   `<src/lib/detached.ts>`): it reports a failure with its cause and never
   rejects. Each long-running entry point (`<the server, each worker>`)
   installs `<installUnhandledRejectionListener>` once, right after the
   logger exists, and runs in the runtime's default mode for unhandled
   rejections (`<no --unhandled-rejections=strict in the start command or
   NODE_OPTIONS>`): under `strict` the rejection ends the process before the
   listener can report it and keep it running. A reported unhandled
   rejection is fixed by routing that work through the helper, never by
   removing the listener.
4. **A route never builds an error response by hand**, and never returns a
   result's error arm as a success body: it maps every error arm,
   exhaustively, to a thrown domain error.

## The boundary

Errors reach callers only through `<the error-handler plugin in
src/plugins/error-handler.ts>`, registered `<first>`. It writes one shape:

| Field | Always | What it is |
|-------|--------|------------|
| `code` | yes | the registered code, or `<SYS-001>` for an error the boundary does not know |
| `message` | yes | the message key |
| `severity` | yes | from the code's metadata |
| `recovery` | yes | from the code's metadata |
| `correlationId` | yes | the request's correlation id, for support to find the server-side detail |
| `details` | on `<4xx>` only | structured context: field errors, the conflicting identifier |
| `detail` | on `<4xx>` only | a sentence for the developer |

The five fields marked "always" are the complete public field set. On a
server-side failure (`<5xx>`) `details` and `detail` are stripped and the
body holds those five fields and nothing more: no exception text, no stack,
no cause, no query text, no file path, no interpolated template, no
identifier. The detail is logged through the allowlist in
`<src/plugins/error-handler.ts>`, keyed by the correlation id. An error that is not a `<DomainError>` and not one of
`<the framework errors the boundary enumerates>` becomes `<SYS-001>` with
status `<500>`; nothing is trusted by its shape. The test
`<src/plugins/error-handler.test.ts>` sends an unknown error, carrying a
recognizable internal message, a cause and a stack, through the boundary,
and asserts that the body holds the five public fields with `<SYS-001>` and
that none of the internal detail (the stack, the cause, query text, a file
path, the internal message) is in it.

## Telemetry

| Signal | Carries | Never |
|--------|---------|-------|
| error counters and duration histograms | labels `error.code`, `error.type` (the class name), `outcome` (`ok` / `err` for a method returning a result) | `error.message`, a user or account identifier |
| spans | status `ERROR` only when the method threw; attributes `error.code`, `error.type`, the error arm's tag as `outcome` | the message or the stack |
| structured logs | fields `code`, `errorName`, `correlationId`; the message and the cause chain as diagnostic detail, through `<the redacting allowlist>` | the request body; a message or cause chain that has not passed through redaction; a message as a field anything aggregates on |

## The checks that hold this

| Rule | Check | Where |
|------|-------|-------|
| no default-returning `catch`, no discarded child error output, no unchecked parse cast | `<lint rule>` | `<biome.json>`, under the ratchet |
| no thrown native error outside `<src/errors/>` | `<lint rule>` | `<biome.json>`, under the ratchet; promoted to an error at zero |
| no branch on message text in a `catch` | `<lint rule>` | `<biome.json>` |
| no un-awaited promise outside `<runDetached>` | `<noFloatingPromises / no-floating-promises>`, plus `<noVoid / no-void>` outside `<runDetached>`'s module, since the first accepts a `void`-started promise | `<biome.json>` |
| a server-side failure carries no internal detail | `<src/plugins/error-handler.test.ts>` | every pull request |
| every generated copy of the codes is fresh, and every code has its message in every locale | `<generate-error-codes.ts --check, generate-error-catalog.ts --check, generate-error-docs.ts --check>` | every pull request |
| no code constructed outside the registry | `<check-no-inline-codes.ts>` | every pull request; allowlist at zero |
| no registered code nothing references, no document naming an unregistered code | `<audit-error-codes.ts>` | every pull request; baseline by identity |
| the transaction rule, the exhaustive mapping of error arms, telemetry keys | review | `<the review checklist>` |
