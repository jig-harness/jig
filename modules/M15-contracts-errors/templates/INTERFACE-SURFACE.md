# Interface surface policy

> Copy this beside your contract (e.g. `api/README.md` or
> `docs/development/api-surface.md`), fill in the placeholders, delete what
> does not apply, and point your agent instruction file at it. It is the
> interface half of the contract in Jig's
> [M15 contracts and error handling](https://github.com/jig-harness/jig/blob/main/modules/M15-contracts-errors/README.md);
> the mark, the bounds and the status list per contract technology are in
> its [mappings](https://github.com/jig-harness/jig/blob/main/modules/M15-contracts-errors/mappings.md#published-interface-surface).
> Terms are defined in Jig's
> [glossary](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).

## Where the contract is

The contract is generated from `<the route schemas under src/routes/>` by
`<bun generate:api>` into two documents: `<api/openapi.yaml>`, the
published interface external consumers build against, and
`<api/internal-openapi.yaml>`, the operations our own clients use. Neither
is edited by hand; `<bun generate:api --check>` fails CI when either is
stale.

## The rules

1. **Internal by default.** A new operation is internal. Mark it at its
   source with `<the tag suffix "(Internal)">`; the generator keeps marked
   operations out of the published document. Publishing an operation is a
   decision, made in the pull request that publishes it, which answers
   three questions in its description:
   - Who is the external consumer? A named role or system, not "future
     customers".
   - What do they get, as a specific outcome? Not "flexibility".
   - Why can they not get it another way: an existing operation, the user
     interface, an export?

   "Someone might want it", "its sibling is public" and "it would be
   inconsistent otherwise" do not answer them. The reviewer's default is
   "internal until a consumer asks". Un-publishing an operation later costs
   a deprecation cycle and a migration window; marking it internal today
   costs nothing and is reversed the day a consumer asks.
2. **Bounded inputs.** Every request input declares a bound in its schema:
   a maximum length, a pattern or a format on a string; a maximum on a
   number; a maximum item count on an array; a closed shape (`<additionalProperties: false>`
   or a value schema) on an object; a type on everything. Use the named
   schemas below instead of an inline bound, so each kind of value carries
   its bound once. A field that is unbounded on purpose carries
   `<x-unbounded: "<the reason>">` in its schema, which the reviewer reads;
   one without a reason fails the check. A numeric query parameter is
   declared numeric with a maximum, not as a string.
3. **Declared failure statuses.** An operation's declared failure responses
   name every status its code can produce: `<500>` from the error boundary,
   `<400>` from validation, `<401>`/`<403>` where authentication and
   authorization run, and the transport status of each domain error the
   handler throws (the error-code registry holds it per code). Every
   success response carries a schema; `<204>` is the only bodiless one.

## Named schemas

| Schema | Bound | Use for |
|--------|-------|---------|
| `<Title>` | `<maxLength: 120>` | the name a person gives a thing |
| `<Query>` | `<maxLength: 160>` | a free-text search term |
| `<Link>` | `<format: uri, maxLength: 1024>` | an address another system resolves |
| `<PageSize>` | `<minimum: 1, maximum: 50>` | how many items a list returns |

One named schema per kind of value, carrying its bound once; the names and
bounds above show the shape and yours replace them. Add a row before adding
an inline bound a second time.

## The checks

| Check | Command | Runs |
|-------|---------|------|
| the documents are fresh | `<bun generate:api --check>` | every pull request |
| no internal operation in the published document | `<bun jig/modules/M15-contracts-errors/reference/interface-surface/check-no-internal-in-published.ts api/openapi.yaml>` | every pull request, after the freshness check |
| the count of unbounded inputs does not rise | `<bun jig/modules/M15-contracts-errors/reference/interface-surface/count-unbounded-inputs.ts --base origin/main api/openapi.yaml>` | every pull request; the count is `<n>` today and only falls |
| the consumer question is answered | the pull-request template's `<Published operations>` field; the `review` skill's contract tier | every pull request that publishes an operation |
| the failure statuses are declared | review, against the codes the handler throws | every pull request that adds or changes an operation |
