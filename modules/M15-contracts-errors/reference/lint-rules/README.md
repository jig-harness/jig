# Lint rules for error handling

Part of [M15 Contracts and error handling](../../README.md).

Lint rules that catch the syntactic half of the module's invariant: a
failure turned into a default value, an empty result or silence; a thrown
native error that carries no type or code; and a branch on an error's
message text. Each is a [GritQL](../../../../GLOSSARY.md) plugin for Biome,
matched on the code's structure rather than its text, with two fixtures
beside it and a self-test that runs every rule alone against them. The rules
are portable examples: a repository on another linter writes the same checks
in its own rule language ([mappings](../../mappings.md)).

## The rules

| Rule | Flags | Leaves alone |
|------|-------|--------------|
| `catch-return-default` | a `catch` that never looks at its error (no binding, or a binding the handler does not use) and returns a default: `null`, `undefined`, `false`, `true`, `[]`, `{}`, `""` or `0` | a handler that mentions the binding (`void error`); a value that is not a default; a rethrow |
| `stderr-ignore` | a child process whose standard error is discarded: Bun's `stderr: "ignore"`, Node's `stdio: "ignore"`, or a `stdio` list whose third entry is `"ignore"` | standard output discarded, which loses no reason |
| `json-parse-cast` | the result of `JSON.parse` cast to a concrete type: `as T`, `as unknown as T`, or a typed declaration | `as unknown` and `: unknown`, which drop `any` honestly; an alias of `JSON.parse` |
| `no-bare-throw-error` | `throw new Error(...)` and the sibling built-in constructors (`TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`), with or without `new`, also spelled through `globalThis` | an alias of a constructor; an error built but not thrown; a thrown subclass of `Error` |
| `no-message-branch` | inside a `catch` clause, a test of `.message`: strict or loose equality in either operand order, `startsWith`, `endsWith`, `includes`, `match`, `indexOf`, `search`, a regular expression's `test` or `exec`, with optional chaining and `toLowerCase` or `toUpperCase` folding | a test outside a `catch` clause (a helper that takes the error as a parameter, a promise's `.catch(callback)`); a `switch` on the message; a destructured `{ message }`; bracket access; another string method in the chain |

Each rule's header comment says what it matches and what it misses. Each
reports at `warn` with a message that opens `jig/<rule>: `, the tag a
[ratchet](../../../M1-gates-enforcement-ladder/reference/ratchet/README.md)
counts findings by, and says what to do instead.

`no-message-branch` matches only inside a `catch` clause on purpose: that is
what tells a caught error's `.message` from an unrelated object's without a
type checker. Inside one, every `.message` test is flagged, an unrelated
object's included. The module's rule (branch on type or code, never on the
message) is wider than the gate; what the gate cannot see is left to review.

## Wiring

Register each rule in `biome.json` with the files it covers. The scope and
the exclusions live there, not in the rule: the typed error family's own
module and the defect primitive construct native errors on purpose, so
`no-bare-throw-error` excludes those files by path, and tests are usually
left out of them all.

```jsonc
{
  "plugins": [
    {
      "path": "./<rules directory>/no-bare-throw-error.grit",
      "includes": [
        "src/**/*.ts",
        "!**/*.test.ts",
        "!src/errors/domain-error.ts",
        "!src/errors/defect.ts"
      ]
    }
  ]
}
```

A codebase with existing findings puts the rules under M1's ratchet: the
count can only fall, a change that adds a finding fails, and a rule whose
count reaches zero is promoted to `error` in its `.grit` file. Jig runs them
on its own code that way (`biome.json` and `tools/quality/ratchet.jsonc`
at the repository root).

## Fixtures and the self-test

`fixtures/<rule>/bad.ts` holds the shapes the rule must match and `good.ts`
the look-alikes it must leave alone; the first line of each states the count
the rule must find (`// expect: <n>`). `lint-rules.test.ts` runs every rule
alone against both through Biome, with Biome's own rules off, and checks the
count and the message tag. Run it from a Jig checkout with
`bun test ./lint-rules.test.ts`: it reads Biome from the checkout's
`node_modules` and the harness from `lib/test-helpers/grit-fixtures.ts`. A
widened pattern fails here before it floods the ratchet, and a new rule is
seen to fail against a wrong count before its pass is trusted.
