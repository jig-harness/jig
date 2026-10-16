# M15 mappings — per-ecosystem implementations

The module [invariant](README.md) is tool-independent: a failure keeps its
cause, travels on one of three channels, is branched on by type or code, and
reaches callers through one boundary. This page maps each piece onto
concrete languages, libraries and frameworks. Replace `<placeholders>` with
your values. The module's reference implementations are its own:
[`reference/detached/`](reference/detached/),
[`reference/error-registry/`](reference/error-registry/),
[`reference/interface-surface/`](reference/interface-surface/) and
[`reference/migration-immutability/`](reference/migration-immutability/)
are TypeScript for Bun and Node, and
[`reference/lint-rules/`](reference/lint-rules/) holds GritQL rules for
Biome; the rest of this page is a feature of the named tool.

## Never swallow, keep the cause

| Ecosystem | Keeping the cause | Lint against swallowing |
|-----------|-------------------|-------------------------|
| TypeScript / JavaScript | `new DomainError(code, { cause: error })`; the standard `Error` `cause` option, read by loggers that print the chain | [`reference/lint-rules/`](reference/lint-rules/) (`catch-return-default`, `stderr-ignore`, `json-parse-cast`) as Biome GritQL plugins; on ESLint, `no-empty` with `allowEmptyCatch: false`, `preserve-caught-error` (a rethrown wrapper must pass `cause`), and `no-restricted-syntax` selectors for a default-returning `CatchClause` and for `stdio: "ignore"` |
| Python | `raise DomainError(code) from error`, which sets `__cause__`; `logging.exception(...)` inside `except` records the traceback | Ruff: `BLE001` (a blind `except Exception`), `S110` (`try`-`except`-`pass`), `B904` (`raise` without `from` inside `except`), `TRY400` (`logging.error` where `logging.exception` keeps the traceback); `subprocess.run(..., stderr=subprocess.DEVNULL)` found by a grep gate |
| Go | `fmt.Errorf("open ledger: %w", err)` wraps with `%w`; `errors.Join` keeps several | golangci-lint: `errcheck` (an error return dropped), `nilerr` (an error checked, then `nil` returned), `errorlint` (`%w`, and `errors.Is`/`As` instead of `==` and type assertions), `wrapcheck` (an error from another package returned unwrapped) |
| Rust | `?` propagates; `thiserror`'s `#[source]` and `#[from]` keep the inner error; `anyhow::Context` adds a message while keeping the chain | `#[must_use]` on `Result` is built in (`unused_must_use`); clippy `let_underscore_must_use` for `let _ = fallible()`; clippy `unwrap_used` and `expect_used` in library code |
| JVM | `new DomainException(code, cause)`; the `Throwable` cause chain | Error Prone `CatchAndPrintStackTrace`, `UnusedException`; SpotBugs `DE_MIGHT_IGNORE`; Checkstyle `EmptyCatchBlock` |
| .NET | `throw new DomainException(code, message, inner)`; `InnerException` | Roslyn analyzers `CA1031` (a catch of a general exception type), `CA2200` (rethrow that loses the stack); `throw;` not `throw ex;` |

Whatever the language, the wrapper's message says what was being done
("open the ledger"), and the cause says what went wrong.

## Failure channels

| Ecosystem | The result type (expected outcomes) | The typed error with a code (module boundaries) | The defect primitive (bugs) |
|-----------|-------------------------------------|-------------------------------------------------|-----------------------------|
| TypeScript, hand-rolled | `type Result<T, E extends { readonly _tag: string }> = { ok: true; value: T } \| { ok: false; error: E }` with `ok`, `err`, `isOk`, `map` and `unwrapOrThrow` beside it; nothing more | `class DomainError extends Error` holding an `ErrorCode` value object (code, severity, message key, recovery hint, transport status); the `_tag` derived from `code` with a literal type, so an exhaustive `switch` narrows to `never` | `invariant(condition, message)` throwing a `DefectError`, in one shared module |
| TypeScript, neverthrow | `Result<T, E>` and `ResultAsync<T, E>` with `ok()`, `err()`, `.match()`, `.andThen()`; `eslint-plugin-neverthrow`'s `must-use-result` fails a dropped result | the same `DomainError`, carried in `E` | the same primitive |
| TypeScript, Effect | `Effect<A, E, R>` with `Data.TaggedError` for the error channel and `Effect.catchTag` to branch; defects are `Cause.Die`, never in `E` | a tagged error class per code, or the domain error wrapped in `Data.TaggedError` | `Effect.die` / `Effect.dieMessage` |
| Python | a `Result` from the `returns` library (`Success`/`Failure`), or a small `@dataclass` union; an exception is never the expected channel | an exception base with a `code` attribute and the code's metadata, raised across module boundaries (`raise NotFoundError(code=...) from error`) | `assert` is stripped under `-O`, so a dedicated `invariant()` raising `DefectError` |
| Go | `(T, error)` is the result channel: an expected outcome returns a sentinel or typed error the caller tests with `errors.Is` / `errors.As` | a struct type implementing `error` with a `Code` field, returned across package boundaries, wrapped with `%w` on the way | `panic` with a dedicated type, recovered only at the top-level handler |
| Rust | `Result<T, E>` is the language; an expected outcome is an `enum` variant in `E` | an error `enum` per crate derived with `thiserror`, each variant carrying its code; `anyhow` only at the binary's boundary | `assert!`, `unreachable!`, or `panic!` with a dedicated message prefix or payload type, all of which run in optimized builds too; `debug_assert!` is compiled out of an optimized build, so it is only for a check the program does not depend on |
| JVM | a sealed interface `Result<T, E>` (Kotlin `sealed class`, Java sealed records) | a `DomainException` holding an `ErrorCode` enum or record | `IllegalStateException` thrown only through an `Invariants.check(...)` helper |

A failure inside a database transaction aborts it, in every ecosystem: the
transaction rolls back and none of its partial work commits. Which path
rolls back is the tool's:

| Transaction mechanism | The path that rolls back | What commits by mistake |
|-----------------------|--------------------------|-------------------------|
| A callback helper that commits when its callback returns: Drizzle's and Prisma's interactive transactions, SQLAlchemy's `with session.begin():` | a throw out of the callback | a returned error arm, which the helper reads as success |
| Spring `@Transactional` | an unchecked exception; a checked one only when `rollbackFor` names it | a checked exception without `rollbackFor`, and a returned error value |
| Go `database/sql` | `defer tx.Rollback()` and an early `return err`; `tx.Commit()` only after every step succeeded | a `Commit` reached after an error was recorded rather than returned |
| Rust SQLx | a `Transaction` dropped without `commit()` rolls back, so an early return through `?` is safe; `Connection::transaction` rolls back on `Err` | `Ok` holding an error value, which commits |

In each case an expected outcome the caller branches on is converted to the
result type outside the transaction, after it has rolled back or committed.

## Branch on type or code

| Ecosystem | Branch on | Lint |
|-----------|-----------|------|
| TypeScript | `error instanceof DomainError`, `error.code`, `result.error._tag`; `assertExhaustive(x: never)` in the `default` of a `switch` over the tag | [`reference/lint-rules/`](reference/lint-rules/) `no-message-branch` and `no-bare-throw-error`; on ESLint, `@typescript-eslint/only-throw-error` (no thrown non-errors) plus a `no-restricted-syntax` selector on `MemberExpression[property.name="message"]` inside a `CatchClause` |
| Python | `except NotFoundError as e:`, `e.code`; `match` on a `Result` union | Ruff `TRY002` (a raised bare `Exception`), `TRY003` (a long message built at the raise site instead of in the exception class); a grep gate on `str(e)` and `e.args[0]` comparisons |
| Go | `errors.Is(err, ErrNotFound)`, `errors.As(err, &notFound)` | `errorlint` (`err == ErrX` and `err.(*T)` instead of `errors.Is` / `As`); a grep gate on `strings.Contains(err.Error(), ...)` |
| Rust | `match` on the error `enum`; `downcast_ref::<E>()` at an `anyhow` boundary | the compiler: an unmatched variant fails the build; clippy `wildcard_enum_match_arm` where exhaustiveness matters |
| JVM | `catch (NotFoundException e)`, `e.getCode()`; an exhaustive `switch` over a sealed type | Error Prone `CatchFail`; a grep gate on `getMessage().contains(` |

## The error boundary

| Stack | The one boundary | The shape it writes | Server-side failures hide detail |
|-------|------------------|---------------------|----------------------------------|
| Express / Koa | the last `(err, req, res, next)` middleware; Koa's `app.on("error")` plus one `try`/`catch` middleware | `{ code, message, severity, recovery, correlationId, details?, detail? }`, with `details` and `detail` on a 4xx only; a `Content-Type` of `application/problem+json` and the Problem Details fields (`type`, `title`, `status`, `detail`, `instance`) are the standard wire form when the shape must be public | the handler strips `details` and `detail` when `status >= 500`, logs them through an allowlist, and maps an unknown error to the generic code |
| Fastify | `setErrorHandler` on the root instance; `setSchemaErrorFormatter` for validation | the same | the same |
| Elysia | `.onError()` in one plugin registered first | the same | the same |
| FastAPI / Starlette | `@app.exception_handler(DomainError)` and one for `Exception` | a Pydantic model for the body | the `Exception` handler returns the generic code and logs; `debug=False` in production so Starlette never writes a traceback |
| Django | one middleware's `process_exception`, or Django REST Framework's `EXCEPTION_HANDLER` setting | the same | `DEBUG = False`; the handler writes the generic code |
| Go `net/http` | a handler wrapper `func(w, r) error` that maps the returned error once | a response struct written by one function | `errors.As` to the typed error, else the generic code and status 500; the internal error only to the log |
| gRPC (any language) | one server interceptor that maps the typed error to a `status` code and `details` | `google.rpc.Status` with `ErrorInfo` (`reason` as the code, `domain`, `metadata`) | an unknown error maps to `INTERNAL` with no message text |
| Rust axum / actix | `impl IntoResponse for AppError`; actix's `ResponseError` | one error `enum` to one body type | the `Internal` variant writes the generic code; the source only to `tracing` |
| Spring | one `@RestControllerAdvice` with `@ExceptionHandler` methods | `ProblemDetail` (Spring 6) with the code in its properties | the `Exception` handler returns the generic code; `server.error.include-stacktrace=never`, `include-message=never` |
| Command-line tools | one exit-code boundary the entry point runs through ([`lib/cli.ts`](../../lib/cli.ts) in Jig) | an exit status per outcome (0 passed, 1 findings, 2 could not check) and one line on standard error | the boundary prints the message, never the stack, unless a debug flag asks |

Whatever the stack, the boundary is the only place that knows the transport:
the domain error carries no status code of a particular transport, the
boundary maps its code's metadata to one. The public field set is the
same everywhere: the code, the message key, the severity, the recovery hint
and the correlation id, plus the 4xx-only details. The test that proves the
rule sends an unknown error, carrying a recognizable internal message, a
cause and a stack, through the boundary, and asserts that the body holds
the public field set with the generic code and that no internal detail is
in it: not the stack, the cause, query text, a file path or the internal
message.

## Detached work and unhandled rejections

| Ecosystem | Detached work through one helper | The process-level backstop |
|-----------|----------------------------------|----------------------------|
| TypeScript (Bun, Node) | [`reference/detached/`](reference/detached/) `runDetached`; Biome `noFloatingPromises` or ESLint `@typescript-eslint/no-floating-promises` finds the un-awaited promise that should go through it, but both accept a promise started with `void`, so the helper is the only way only when a second rule rejects `void` outside the helper's module: Biome `noVoid` or ESLint `no-void`, with that module excluded, or `no-floating-promises` with `ignoreVoid: false` | `installUnhandledRejectionListener` from the same file, once per entry point, in the runtime's default mode (`--unhandled-rejections=throw`, which Bun follows), where the listener handles the rejection and the process keeps running; under `--unhandled-rejections=strict` the rejection is raised as an uncaught exception first and the listener does not prevent the exit, so the entry point sets no `strict` flag in its start command or `NODE_OPTIONS` |
| Python asyncio | tasks kept in a set and given a done callback that reports (`task.add_done_callback(report)`); a task with no reference is collected mid-flight | `loop.set_exception_handler(report)`: the "Task exception was never retrieved" warning is what it replaces |
| Go | a `go func()` started through one `spawn(name, fn)` that recovers a panic and reports it with the name | none exists: an unrecovered panic in a goroutine ends the process, which is why every goroutine starts through the helper |
| Rust tokio | `JoinSet` or a `JoinHandle` that is awaited; a `tokio::spawn` whose handle is dropped reports nothing | a `panic` hook (`std::panic::set_hook`) that logs; the task's `JoinError` is read where the handle is awaited |
| JVM | an `ExecutorService` wrapper that submits through `Callable` and logs a failed `Future`; Kotlin `CoroutineExceptionHandler` on the scope | `Thread.setDefaultUncaughtExceptionHandler` |

## Telemetry keyed on code and type

| Signal | Keys | Never |
|--------|------|-------|
| Metrics (a counter of errors, a duration histogram) | `error.code` (the registered code), `error.type` (the class name, as the OpenTelemetry semantic conventions name it), `outcome` (`ok` or `err` for a method returning a result type) | `error.message`, an account or user identifier (unbounded cardinality: the OpenTelemetry metrics SDK merges combinations past its per-instrument limit into one overflow bucket, silently) |
| Spans | span status `ERROR` only when the method threw; `error.code` and `error.type` as attributes; the `err` arm's tag as `outcome` | the message or the stack as an attribute |
| Structured logs | the fields `code`, `errorName` and `correlationId`; the diagnostic detail (the message and the cause chain's messages) through the redacting allowlist, with secrets and identifiers masked, and never as a field a dashboard groups by | the request body; a message or a cause chain that has not passed through redaction |

The boundary and the telemetry wrapper read the same fields of the same
typed error, so a code renamed in the registry changes both, and a dashboard
built on codes outlives any rewording.

## The error-code registry

The registry is one declaration per code, in data
([`templates/error-codes.yaml`](templates/error-codes.yaml)) or in a code
module with the same fields; the generators below read it, and each copy
they write carries [M2's](../M2-generated-artifact-freshness/README.md)
freshness triad, with a `--check` that regenerates through the generator's
own function and diffs the whole text.

| Ecosystem | The registry | The client's code union | A message catalog per locale | The public reference |
|-----------|--------------|-------------------------|------------------------------|----------------------|
| TypeScript | a module of `new ErrorCode(code, metadata)` constants, the class unexported where it can be | a generated file holding a string-literal union and a runtime array of the codes, so a `switch` narrows to `never` and a new code fails the client's build until it is handled | JSON per locale for i18next, next-intl or react-intl, where the generator keeps authored entries, inserts a visible placeholder entry for a new code and drops a retired one, and `--check` fails on a difference or a placeholder; `typesafe-i18n` derives types from the base locale so a key missing elsewhere fails the build | a generated Markdown page in the docs site (Docusaurus, Starlight), validated by regenerating through the same function |
| Python | an `Enum` whose members carry the metadata, or the data form read by the generators | a generated `Literal[...]` type in the client package | gettext `.po` per locale; `msgfmt --check` validates the files, and a test that resolves every code's key in every locale fails on a gap (gettext returns the key itself when it is missing, so the test asserts inequality) | a generated page under Sphinx or MkDocs, with `--check` |
| Go | a `const` block of codes and a `var` table of metadata in one package | a generated file in the client module, `go generate` with `stringer` for the string form | `golang.org/x/text/message` catalogs from `gotext update`, which reports untranslated messages | a generated Markdown page; CI runs `go generate ./...` and `git diff --exit-code` |
| Rust | an `enum ErrorCode` with a `metadata()` match and `strum` for the names | the crate shared with the client, or a TypeScript union generated with `ts-rs` or `specta` | Fluent `.ftl` per locale; `i18n-embed-fl`'s `fl!` macro checks at compile time that a message id exists in the fallback language | a generated Markdown page; CI regenerates and `git diff --exit-code` |
| JVM | an `enum ErrorCode` with a field per metadata item | generated from the specification's `enum` with openapi-generator, or the enum shared in a client module | `ResourceBundle` properties per locale, with a test over `ErrorCode.values()` for every locale; Spring's `MessageSource` with `useCodeAsDefaultMessage=false` throws on a missing key | a generated page from an annotation processor or a test that writes and compares |
| Rails | a model of codes with `config/locales/*.yml` keyed by code | a generated TypeScript union from a Rake task | `i18n-tasks missing` fails CI when a locale lacks a key the base locale has | a generated page from the same Rake task |
| On the wire | the response schema's `code` property is an `enum` generated from the registry in the OpenAPI document, so a client generated from the specification carries the union; gRPC carries the code in `google.rpc.ErrorInfo.reason`, with a generated protobuf `enum` beside it | | | |

| Ecosystem | No code constructed outside the registry | Orphans and reverse orphans |
|-----------|------------------------------------------|-----------------------------|
| TypeScript | visibility: the registry module exports the codes and not the class; where the class must be exported, [`reference/error-registry/check-no-inline-codes.ts`](reference/error-registry/), a Biome GritQL rule on `new ErrorCode($args)` with the registry left out of its `includes`, or ESLint `no-restricted-syntax` on `NewExpression[callee.name="ErrorCode"]` turned off for the registry in an `overrides` entry | [`reference/error-registry/audit-error-codes.ts`](reference/error-registry/) over the packages and the docs; Knip reports a registry constant nothing imports as an unused export |
| Python | a module-private constructor (`_Code`) and `import-linter`'s `forbidden` contract against importing it outside the registry package; otherwise a [grep gate](../../GLOSSARY.md) on `ErrorCode(` outside the registry | the audit; `vulture` for a constant nothing reads |
| Go | an unexported constructor (`newCode`) in the registry package: the compiler enforces it; `forbidigo` where it must be exported | the audit: an unreferenced exported variable is not something `staticcheck` reports across packages |
| Rust | a private constructor in the registry module: `ErrorCode` keeps a private field, so no other module can build one with a struct literal, its `new` is private to the module, and the codes are associated constants (`ErrorCode::ORDER_NOT_FOUND`) declared beside it; the compiler enforces it. `pub(crate)` is not enough, since every module of the crate can call it | the audit; the `dead_code` lint reports only a constant that is not `pub` |
| JVM | a package-private constructor; ArchUnit's `noClasses().that().resideOutsideOfPackage("..errors.registry..").should().callConstructor(ErrorCode.class, ...)` | the audit |
| Documents, any stack | | the audit's `--docs` over the hand-written pages; `i18n-tasks unused` (Rails) for catalog keys nothing resolves |

Whatever the stack, the set of packages the gate scans is derived from the
dependency graph (every package that depends on the error module:
`pnpm --filter "...^<errors package>" exec pwd`, `cargo tree -i <crate>`,
`go list -deps`), not listed by hand, so a new dependent is covered the day
it appears. The allowlist is kept at zero; the baseline of accepted orphans
names each code with its reason and only shrinks.

## Migration discipline

A migration that has merged is never edited, renamed or deleted; the ledger
and the files match one to one in strictly increasing order; a migration
changes structure only. The merge-time gate is one script for every tool
([`reference/migration-immutability/`](reference/migration-immutability/)):
it reads git, not the database. The apply-time hash check and the ledger
are each tool's own, and differ in what they refuse.

| Tool | The ledger and its order | The hash at apply, and what refuses drift | What the repository adds |
|------|--------------------------|-------------------------------------------|--------------------------|
| Flyway | the versioned files' own numbering; `validate` (run by `migrate` by default, `validateOnMigrate`) fails on a resolved migration older than the latest applied that never ran, so a behind migration is refused, not skipped; `outOfOrder=true` is the setting that lets it run, off by default | `flyway_schema_history` records a checksum per versioned migration; `validate` fails on a changed one; `repair` rewrites the recorded checksums and is the escape hatch to keep out of CI | the merge-time gate, so the edit fails in review rather than at the deploy |
| Liquibase | the changelog file is the ledger and runs changesets in its order, so a changeset file no `include` names never runs: a check that every file under the directory is included | `DATABASECHANGELOG` records a digest per changeset; `update` fails on a changed one (checksum validation); `runOnChange`, `validCheckSum` and `clearCheckSums` are the escape hatches | the merge-time gate; the inclusion check |
| Rails (Active Record) | `schema_migrations` records the versions applied; every pending version runs in version order, older ones included, so nothing is skipped; `db:migrate:status` prints `NO FILE` for a recorded version with no file | none: the table records versions only | the merge-time gate is the only guard against an edit; a hash check in a Rake task that records the digests it applied; `strong_migrations` stops an unsafe structure change and a raw `execute` without `safety_assured`; data changes go to `data_migrate`'s own directory |
| Alembic | the revision chain in the files (`down_revision`) is the ledger; `alembic heads` returning more than one revision, which `upgrade head` refuses, is the integrity check; `alembic_version` records the current head only | none | the merge-time gate; a hash check in the migration command's wrapper; a data change (`op.bulk_insert`, `op.execute` with a data statement) found by walking the Python syntax tree (`ast`) and parsing the SQL it carries |
| Prisma Migrate | the migration directories' names, applied in name order; `migrate status` lists them against `_prisma_migrations` | `_prisma_migrations` records a checksum per migration; `migrate dev` refuses an applied migration that changed; `migrate deploy` applies pending migrations and compares no checksum; `migrate resolve` is the escape hatch | the merge-time gate is the production guard, since `deploy` checks nothing |
| Drizzle | `meta/_journal.json`: an entry per migration with `idx`, `tag`, `when` and `breakpoints`; the migrator applies entries whose `when` is greater than the last applied `created_at`, so an entry with an earlier `when` is skipped silently; a ledger check holds `idx` dense, `when` strictly increasing, `tag` and file one to one, and every field explicit on every entry | `__drizzle_migrations` records a hash per applied entry and the migrator compares none | both checks are the repository's: the ledger check above, and a drift check in the migration wrapper that pairs the recorded hashes with the journal's entries by position, hashes each file the same way, and refuses to run on a difference or a missing file; the migrator applies every pending entry in one transaction, so a statement PostgreSQL will not run inside one (`CREATE INDEX CONCURRENTLY`) or whose effect waits for the commit (`ALTER TYPE … ADD VALUE`) needs its own path outside the migrator |
| golang-migrate | the files' version numbers; `up` applies the versions above the recorded one, so a version behind it never runs: a check that the files' versions are strictly increasing and that every file above the recorded version is pending | `schema_migrations` records the current version and a dirty flag, no checksum | the merge-time gate; a hash check in the wrapper; goose, the near relative, refuses a missing migration before the current version by default (`-allow-missing` is the setting that lets it through) and records no checksum either |

A runner with no hash check gets one in the repository's own wrapper: on
first apply it records a digest of each file in a table beside the tool's
own; on every run it recomputes the digests of the applied files and
refuses to continue on a difference or a missing file, naming the file, the
recorded digest and the file's. The recovery is always the same: restore
the file, or reset an environment that never applied it, or add a new
migration.

| Database | The parser for the structure-only check | What to walk |
|----------|------------------------------------------|--------------|
| PostgreSQL | the `libpg_query` bindings: `pg_query` (Ruby), `pglast` (Python), `pg_query_go` (Go), `@pgsql/parser` (TypeScript) | every `InsertStmt`, `UpdateStmt`, `DeleteStmt` and `MergeStmt` anywhere in the tree, a `WITH` query's included; the body of a `DO` block and of a `CREATE FUNCTION` through the procedural-language parser (`pglast.parse_plpgsql`); an `EXECUTE` of a constant string re-parsed, any other `EXECUTE` fails the file |
| MySQL, MariaDB, SQLite | `sqlglot` (Python) with the dialect named | `exp.Insert`, `exp.Update`, `exp.Delete` found by `find_all` over each parsed statement |
| SQL Server | `ScriptDom` (`TSql160Parser`) | a visitor over `InsertStatement`, `UpdateStatement`, `DeleteStatement`, `MergeStatement` |
| Migrations written as code (Alembic, Rails, Knex) | the language's own syntax tree for the data operations (`op.bulk_insert`, `op.execute`, `execute`, `update_all`, `insert`), then the database's parser for the SQL strings they carry | the same statement kinds |

The allowlist for a data change that must ride in a migration is a file
outside the migrations, one entry per statement by identity (the file and
the statement with its whitespace normalized), each under the reviewer's
reason; an entry whose statement is no longer there fails the check
([M1's stale-exceptions rule](../M1-gates-enforcement-ladder/README.md)).
An in-file marker cannot do this job: the file that needs it has already
applied, and gaining a marker is an edit.

The review marker is [M1's commit-msg marker](../M1-gates-enforcement-ladder/reference/commit-msg-marker/)
with `REVIEW_PATHS_RE` set to the migrations directory and `REVIEW_MARKER`
to the migration-review tag, re-checked in CI over the pull request's
commits.

## Published interface surface

An operation is internal unless a named external consumer justifies
publishing it; every request input declares a bound; an operation's
declared failure responses name every status its code can produce. The two
reference gates read an OpenAPI document
([`reference/interface-surface/`](reference/interface-surface/)); for
another contract form, the same checks are written over its own document.

| Contract form | The mark at the source | Two documents from one source | The gate over the published document |
|---------------|------------------------|-------------------------------|---------------------------------------|
| OpenAPI (REST) | a tag suffix on the operation (`Orders (Internal)`), an `x-internal: true` extension, or a path prefix (`/internal/`), set where the route is declared so the generator reads it from the route schema | the generator runs twice with the filter inverted: the published document without the marked operations, the internal one with only them; over a bundled document, `redocly bundle --remove-x-internal` or an `openapi-filter` pass apply the same filter | [`check-no-internal-in-published.ts`](reference/interface-surface/) with the mark as its option; the server's own filter on what it serves at its contract endpoint is tested where the server is |
| gRPC / protobuf | a package per audience (`<org>.orders.v1` published, `<org>.orders.internal` internal), or the `google.api.visibility` method option (`restriction: "INTERNAL"`), which `protoc-gen-openapi` and the generated-client generators honour | one module, a `buf generate` template per audience, each built from its package (`buf build --path`) | a check over the published descriptor set (`buf build -o`) that no internal package and no `INTERNAL`-restricted method is in it; `buf breaking --against` on the published package holds its shape |
| GraphQL | a schema directive on the field or type: Apollo Federation's `@inaccessible`, which composition drops from the supergraph's API schema, or a `@tag` per audience read by a schema contract; a plain `@internal` directive the build filters | one subgraph schema; the published schema is what composition or the contract filter leaves | `graphql-inspector validate` with a rule, or a short script over the published schema's syntax tree, that no field or type carrying the mark remains; `graphql-inspector diff` against the base holds the shape |
| Typed RPC (tRPC and kin) | a router per audience (`publicRouter`, `internalRouter`), mounted at different paths; the client types are generated per router | the type generation per router | a type-level test that no internal procedure is assignable to the public router's exported type |

The consumer question travels with the change: a pull-request template
field, or a line in the review checklist, asks who the external consumer of
a newly published operation is, what they get, and why not another way.
Jig's `review` skill asks it in its contract tier.

| Schema tool | The bound | Named schemas with their bounds | The count under the ratchet |
|-------------|-----------|---------------------------------|-----------------------------|
| OpenAPI / JSON Schema | `maxLength`, `pattern`, `format` on a string; `maximum`, `exclusiveMaximum` on a number; `maxItems` on an array; `additionalProperties: false` or a schema on an open object; `enum`, `const` on anything | `components/schemas` entries (`ShortText`, `EntityName`, `SearchQuery`) referenced by `$ref` | [`count-unbounded-inputs.ts --base`](reference/interface-surface/) over the document |
| TypeBox (TypeScript) | `t.String({ maxLength })`, `t.String({ pattern })`, `t.Number({ maximum })`, `t.Array(..., { maxItems })`; the OpenAPI document generated from the route schemas carries them | one module of named schemas (`const ShortText = t.String({ maxLength: 500 })`), a refinement by spread (`{ ...ShortText, minLength: 1 }`) keeps the bound | the document count; a numeric query parameter declared as a string is a bound in name only, so it is `t.Numeric({ maximum })` |
| Zod | `.max()`, `.regex()`, `.email()`, `.url()`, `.array().max()`, `.number().max()`; `zod-to-openapi` and `zod-openapi` carry them into the document | named schemas exported from one module | the document count, or a lint rule on `z.string()` and `z.number()` with no refinement in a request schema |
| Pydantic (Python) | `Field(max_length=, pattern=, le=)`, `conlist(max_length=)`, `constr`, `conint`; FastAPI's generated document carries them | `Annotated[str, Field(max_length=255)]` aliases in one module | the document count |
| Protobuf | `protovalidate` (`buf.validate`) field options: `(buf.validate.field).string.max_len`, `.repeated.max_items`, `.int32.lte`, `.string.pattern` | a message per kind of value, or a shared custom option | a `buf lint` plugin, or a script over the descriptor set, counting request fields with no constraint |
| GraphQL | `graphql-constraint-directive` (`@constraint(maxLength: 255, pattern: ...)`) on input fields and arguments; a custom scalar per kind of value (`ShortText`) | the custom scalars | a script over the schema's syntax tree counting `String`, `Int` and list inputs with no constraint |
| Go (`validator`) | struct tags on the request types (`validate:"max=255"`, `validate:"dive,max=100"`), `max=` on slices | a named type per kind of value with its own `Validate` | a `go vet` analyzer, or a grep gate over the request structs, for a string or slice field with no `max` tag |

| Contract form | Where the failure statuses are declared | What the list holds |
|---------------|------------------------------------------|---------------------|
| OpenAPI | the operation's `responses` map | the boundary's generic server-side status; the validation status; the authentication and authorization refusals where those layers run; the transport status of each domain error the handler throws, which the registry holds per code, so a generator can derive the list from the codes the route declares; a `2xx` with a schema, never an untyped success |
| gRPC | the method's comment (`// Errors: NOT_FOUND, FAILED_PRECONDITION`) and the `google.rpc.Status` details, with `ErrorInfo.reason` carrying the registry's code | the status codes the handler returns and the boundary's `INTERNAL`; the generated client's documentation reads the comment |
| GraphQL | an enum of `errors[].extensions.code` in the schema, and each field's description naming the codes it raises | the registry's codes, so the client's exhaustive switch over the enum narrows to `never` |
