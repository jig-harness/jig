# Published interface surface gates

Part of [M15 Contracts and error handling](../../README.md).

An interface is internal unless a named external consumer justifies
publishing it, and every request input declares a bound. Both rules live in
the contract document the consumer builds against, so both gates read that
document (an OpenAPI document, as JSON or YAML) and nothing else: no route
source, no framework, no repository path. A repository whose contract is in
another form (a protobuf package, a GraphQL schema) writes the same two
checks over its own document ([mappings](../../mappings.md#published-interface-surface)).

Both import helpers from the Jig repository's `lib/` (`cli.ts`, the
exit-code boundary; `files.ts`; `findings.ts`; `record.ts`), and
`count-unbounded-inputs.ts` alone reads git, through
`plugin/shared/guarded-git-spawn.ts`; run them from a pinned Jig checkout,
or vendor those files with them.

## `check-no-internal-in-published.ts`: no internal operation in the published contract

```bash
bun check-no-internal-in-published.ts [--tag '\(Internal\)$'] [--path '^/internal(/|$)'] [--extension x-internal] <contract>
```

- `--tag` — a regular expression; an operation carrying a tag that matches
  is internal, and so is a matching entry in the document's tag catalog.
- `--path` — a regular expression over the operation's path.
- `--extension` — a specification extension; an operation, or its path
  item, that sets it to `true` is internal.
- The contract: the published document, the one the generator wrote with
  the internal filter on.

The published and the internal documents come from one source, each
operation marked once (a tag suffix, a path prefix or an extension field,
whichever the generator reads), and the generator writes two documents: the
published one without the marked operations, the internal one with only
them. This gate is the check that the filter held: it fails on any mark of
the internal kind in the published document. The marks are options because
the generator's convention is the repository's; the defaults are the three
forms in common use.

An operation whose `tags` is not absent or an array of strings cannot be
classified, and the gate stops (exit 2) rather than guess: a generated
document with an unreadable `tags` is the generator's failure, and a pass
over it would mean nothing. Both gates read a path item that is a local
reference (`$ref: "#/components/pathItems/Orders"`) through it, with the
fields set beside the reference added; a field set both beside it and on
the referenced item has no defined meaning, and stops the gate.

### Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | No internal operation in the published document | `OK — <n> operation(s) in <contract>, none internal` |
| 1 | Findings | one `[internal-in-published]` line per operation, with the mark that makes it internal, and one per internal tag in the catalog, each with the remedy |
| 2 | Could not check | a message on standard error: the document missing, unreadable, empty or not a contract, no operation under `paths`, a path item or an operation that is not an object, a path item reference the gate cannot follow, an unreadable `tags`, a pattern that is not a regular expression, a bad option |

## `count-unbounded-inputs.ts`: every request input declares a bound

```bash
bun count-unbounded-inputs.ts [--max <n>] [--base <ref>] [--repo <dir>] [--extension x-unbounded] <contract>
```

- `--base` — the branch the change merges into. The same count is taken
  over the document at the merge base of that branch and `HEAD`, read from
  git rather than the working tree, and the head's count may not exceed it.
  This is [M1's ratchet](../../../M1-gates-enforcement-ladder/reference/ratchet/README.md)
  shape: the base is derived, nothing is stored.
- `--max` — a ceiling the count may not exceed; `--max 0` is the strict
  form. With both options, both hold. With neither, any unbounded field
  fails.
- `--repo` — the repository `--base` reads and the contract path is
  relative to; default the working directory.
- `--extension` — the specification extension that marks a field unbounded
  on purpose, with the reason as its value.
- The contract: the document whose request inputs are counted; the
  published one, the internal one, or each in turn.

The walk covers every operation's request inputs: the parameters of the
path item and the operation (query, path, header, cookie; the operation's
override the path item's by name and location) and the request body's
schema under each media type, through local `$ref`s, `allOf`/`oneOf`/`anyOf`,
object properties, array items and `additionalProperties` schemas. A
`$ref` and the keywords beside it, and the parts of an `allOf`, all hold at
once, so they are read as one schema (the intersection) before it is
judged: a type in one part and its bound in another is a bounded field.
Each part of a `oneOf` or `anyOf` is an alternative a value may take, and is
judged together with the keywords around it, which hold for every
alternative, and with one alternative of each other `oneOf` or `anyOf` that
holds beside it, since a value satisfies all of them at once. A field
reached through several alternatives is one field, counted once. A
reference is followed once per path, so a recursive schema ends; the
keywords beside a reference met again below itself are still walked, and a
reference met again beside itself at the same field is judged as any other.
A field is below a reference only when the reference's own content defines
it: a mixin an object and its nested field both use is walked at each. A keyword that admits values the walk does not follow
(`prefixItems`, `additionalItems`, `patternProperties`,
`unevaluatedItems`, `unevaluatedProperties`, each unless `false`) is could
not check rather than a silent zero. Responses are not inputs and are not
counted.

A field is unbounded when:

| Field | Bounded by |
| --- | --- |
| a string | `maxLength`, `pattern` or `format` |
| a number or integer | `maximum`, or `exclusiveMaximum` as a number |
| an array | `maxItems` (its items are walked as well) |
| an object | `additionalProperties` set to `false` or to a schema (which is walked); its named `properties` are walked as well, and do not close it |
| anything | `enum` or `const` |

A field whose `type` lists several types is bounded only when each of them
is (`null` needs no bound, nor does a boolean). A schema with no type and
none of a composition, `items`, `properties`, `enum` or `const` is
unbounded as "no type"; a parameter or media type with no schema at all,
and a boolean `true` schema, are unbounded too. A boolean `false` schema
accepts nothing, so it is bounded.

A keyword the walk reads that is present in a shape it cannot read stops
the gate (exit 2) rather than count as a bound or as none: `maxLength` or
`maxItems` that is not a non-negative integer, `maximum` that is not a
number, an empty `pattern` (which accepts every string) or one that is not
a regular expression, an empty `format`, an `enum` or a composition that is
not a non-empty list, a `type` that names no JSON Schema type, a schema
that is neither an object nor a boolean. So does a request container
present in a shape it cannot read: `parameters` that is not a list, a
parameter with no name or location, one parameter declared twice in one
list, a parameter's `content` that is not exactly one media type, a request
body whose `content` is not a non-empty map of media types.

A field that is unbounded on purpose (an opaque payload the service
validates against another schema) carries the extension with a reason,
`x-unbounded: "<reason>"`, and is counted as accepted. The extension with an
empty value fails the gate at any count, whatever the base or the ceiling,
so the exception is a reviewed decision with its reason beside it. The pass
line says how many are accepted.

### Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | The count holds | `OK — <n> unbounded input field(s) across <k> operation(s) in <contract>[; <a> accepted with a reason][; within <limits>]` |
| 1 | It does not | one `[unbounded-input]` line per field, with its place (`POST /orders body.items[].name`) and what it lacks, then the count and the limit it exceeded; or one line per exception without a reason |
| 2 | Could not check | a message on standard error: the document missing, unreadable, empty or not a contract, no operation under `paths`, a reference the gate cannot follow (only local `#/…` references are read), a keyword or a request container present in a shape the gate cannot read, a parameter declared twice in one list, alternatives, `allOf` parts and references that expand into more than 100,000 steps, a base that names no commit or has no merge base with `HEAD`, a document absent at the merge base (use `--max` for a new contract), a contract outside the repository, a bad option |

## Wiring

Run both on every pull request, after the contract's own generation and
drift check ([M2](../../../M2-generated-artifact-freshness/README.md)), so
a stale document is caught before a clean one is read:

```yaml
- run: git fetch --no-tags origin main
- run: bun <jig>/modules/M15-contracts-errors/reference/interface-surface/check-no-internal-in-published.ts api/openapi.yaml
- run: bun <jig>/modules/M15-contracts-errors/reference/interface-surface/count-unbounded-inputs.ts --base origin/main api/openapi.yaml
```

A finding of the first gate is fixed at the source, never in the document:
regenerate with the filter, or, when the operation is now public, name its
external consumer in the change and remove the mark. A finding of the second
is a bound added to the schema; the count falls as fields are touched and the
ratchet holds every fall.

## What they do not see

The first gate reads the document, not the server: a route the generator
never saw is not in either document, and the server's own filter on what it
serves at its contract endpoint is tested where the server is. The second
counts what the contract declares, not what the validator enforces: a bound
in the document that the framework does not read is a documentation bound,
and the drift check between the route schemas and the document is what
keeps the two the same.

## Fixtures and the self-test

`fixtures/published/` holds a published document that is clean, one with
every kind of internal mark, one with an unreadable `tags`, one with no
operation and an empty file; `fixtures/inputs/` holds a contract whose every
input is bounded (through references, a composition, a map and a recursive
schema, with one accepted exception), one with each kind of unbounded field
and a reference to nothing. `interface-surface.test.ts` runs both gates
against them for each of the three outcomes, tests the classification and
the schema walk directly (type lists, open objects, intersections, a
reference with keywords beside it, boolean schemas, unreadable keywords and
containers, path item references), writes small contracts to a scratch
directory for the cases it runs end to end, and builds a scratch git repository per `--base`
scenario (a count that stays, falls or rises; a contract absent at the
base; a base that names no commit). Run it from a Jig checkout with
`bun test ./interface-surface.test.ts`.
