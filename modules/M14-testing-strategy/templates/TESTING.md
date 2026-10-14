# Testing strategy

> Copy this into your repository (e.g. `docs/development/testing.md`), fill in
> the tables, delete what does not apply, and point your agent instruction
> file at it. It is the tool-independent contract from Jig's
> [M14 testing strategy](https://github.com/docomply/jig/blob/main/modules/M14-testing-strategy/README.md);
> the tools for each rule, per language, are in its
> [mappings](https://github.com/docomply/jig/blob/main/modules/M14-testing-strategy/mappings.md).
> Terms are defined in Jig's
> [glossary](https://github.com/docomply/jig/blob/main/GLOSSARY.md).

## Tiers

Every suite has a tier, a trigger and a time budget. A suite that outgrows
its budget moves to a slower tier or is split; the budget does not stretch.

| Suite | Tier | Trigger | Budget | Where it is configured |
|-------|------|---------|--------|------------------------|
| `<unit tests>` | unit | every push | `<60 s>` | `<CI job, runner timeout>` |
| `<integration tests>` | integration | pull requests that change `<paths>`, and every push to the default branch | `<5 min>` | `<CI job>` |
| `<critical-journey end-to-end tests>` | end-to-end | every push to the default branch, before the `verified` pointer moves | `<10 min>` | `<CI workflow>` |
| `<full end-to-end sweep>` | end-to-end | nightly and on demand; never per change | `<30 min>` | `<CI workflow>` |

The full-sweep workflow carries the marker `# test-tier: end-to-end`, and
`<check script>` fails if a marked workflow gains a per-change trigger. Per
change, `<cheap stand-in, e.g. "the end-to-end images build">` runs instead.
End-to-end tests that are the only check of a journey are not part of the
sweep: they run on every push to the default branch, where the `verified`
pointer waits for them ([M10](https://github.com/docomply/jig/blob/main/modules/M10-environments-deploy/README.md)).

## Rules for every test

1. **Doubles are honest.** A fake, stub or mock rejects what the real
   dependency rejects. Its accepted inputs are written from the real tool's
   documentation, not read from the code under test, and it is typed
   against the real interface. A new boundary is proven by a mutation check:
   misspell the flag at the call site, see the test fail, restore it.
2. **Time is injected.** Runtime code reads the current time only from the
   clock it is given (`<Clock type and where it lives>`). `<lint rule>`
   rejects direct reads; arithmetic on the clock's value is fine.
3. **Poll, don't sleep.** Wait for external state with `<polling helper>`,
   which has a hard deadline and names what it waited for. A fixed delay is
   allowed only for local timing (retry back-off, an abort deadline, the
   pause between polls) and carries `fixed-delay: <reason>` on the same line
   or the line above; `<sleep gate>` rejects any other.
4. **Predicates are proven where they run.** Tenant scope, soft delete and
   authorization are tested against `<the real database / policy engine>`,
   with a second tenant's data or a deleted record that would leak if the
   predicate were missing.
5. **Test data comes from typed builders** (`<where builders live>`). A
   builder returns one declared contract type with fixed defaults; a test
   overrides only the fields it is about.
6. **Tests are code.** Test files are type-checked by `<type-check command>`
   in CI. A new test is seen to fail once before its pass is trusted.
7. **Tests come with changes.** A changed file under `<source globs>` comes
   with a test at `<test path convention>`, or a line in
   `<exemptions file>` giving its reason. `<gate>` checks this in the
   pre-push hook and in CI.
8. **No real developer state.** A test that needs a different home
   directory, working directory or environment variable runs the code under
   test in a subprocess with those values; it never changes them in the test
   process.

## Exemptions

`<exemptions file>` lists the paths that need no test, one per line, as
`<glob> <reason>`. Every line is a place the rule does not reach, so each is
reviewed like code.

```text
src/generated/** Generated from the schema; the generator has its own tests.
```

## Coverage

Coverage is measured `<weekly>` by `<CI workflow>` and published to
`<dashboard>` as a trend, including when it is below target. The publisher
refuses to publish when a package's report is missing or unreadable. No
merge is blocked on a per-file coverage number.

## Suppression tokens

Register these in the suppression-token registry
([M1 template](https://github.com/docomply/jig/blob/main/modules/M1-gates-enforcement-ladder/templates/suppression-registry.md)):

| Token | Suppresses (gate) | Placement | Justification required |
|-------|-------------------|-----------|------------------------|
| `fixed-delay: <reason>` | `<sleep gate>` | same line as the delay, or the line above | non-empty reason |
| `<exemptions file>` entry | `<tests-with-changes gate>` | one line per path pattern | non-empty reason |
