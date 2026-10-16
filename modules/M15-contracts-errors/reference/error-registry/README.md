# Error-code registry gates

Part of [M15 Contracts and error handling](../../README.md).

Every code a system can emit is declared once, in one
[error-code registry](../../../../GLOSSARY.md), and every other copy is
generated from it. Two things undo that without anyone noticing: a code
minted inline at a throw site, which no generated copy carries, so the first
the outside learns of it is the response; and the registry and the code
drifting apart, a registered code nothing throws any more, or a hand-written
page naming a code the registry retired. These two gates catch both. They
are text scans that take their inputs as arguments and carry no repository's
paths, so they run on any language whose constructor call and code literals
look as described; a repository with a parser for its language writes the
same checks over its syntax tree ([mappings](../../mappings.md)).

Both import helpers from the Jig repository's `lib/` (`cli.ts`, the
exit-code boundary; `files.ts`; `findings.ts`), so run them from a pinned
Jig checkout, or vendor `lib/` with them.

## `check-no-inline-codes.ts`: no code constructed outside the registry

```bash
bun check-no-inline-codes.ts --registry <path> [--registry <path>]... \
  [--constructor ErrorCode] [--allowlist <file>] [--root <dir>] \
  [--ext .ts,.tsx,.mts,.cts] <path>...
```

- `--registry` — a file or directory where construction is allowed; what
  lies under it is not scanned. Required, repeatable.
- `--constructor` — the name after `new`; default `ErrorCode`.
- `--allowlist` — the debt file described below.
- `--root` — the directory every path and allowlist entry is relative to;
  default the working directory. Findings print paths relative to it.
- `--ext` — the file extensions scanned.
- The paths are the files, or directories, to scan. Pass every package that
  depends on the error module; derive that set from the dependency graph
  rather than listing it by hand, so a new dependent is covered the day it
  appears (`pnpm --filter "...^<errors package>" exec pwd` lists the
  dependents of a workspace package; `cargo tree -i <crate>` the crates that
  depend on one).

The scan finds `new <Constructor>(` outside comments and literals: strings,
the text of a template literal and regular expression literals. After each
`new` it reads the callee as a member chain, not one spelling: whitespace and
comments between the tokens, parentheses (`new (ErrorCode)(`,
`new (errors).ErrorCode(`), members by name or by string
(`new errors.ErrorCode(`, `new errors['ErrorCode']`), non-null assertions
(`new errors!.ErrorCode(`) and type arguments inside or outside the
parentheses, read as one balanced group (`new ErrorCode<() => (Meta)>(`), in
any order. A literal inside a group is one token, so a `)` in a regular
expression closes nothing. The chain's last name is what
is constructed, so `new ErrorCode.Sub(` is not a construction of `ErrorCode`.
Where the chain does not settle a name (`new (flag ? A : ErrorCode)(`, a
computed member), any mention of the constructor's name there counts, and
so does literal text that could spell it where a name is read from it: a
computed key, an array or object literal, or a call's arguments, at any
depth. A `+` chain of plain literals and unknown values is matched exactly
against the name, so `errors['Error' + 'Code']` and `errors[prefix + 'Code']`
count and `handlers['Other' + 'Thing']` does not. A literal the chain
transforms (`'Error_Code'.replace(...)`) or escapes counts, since the reader
evaluates nothing beyond `+`. A template's text from the first `${...}` that
holds a literal or a `/` on is unknown, since a brace there may sit in a
regular expression or a string, so `` errors[`Error${/}/.source}`] ``
counts and `` handlers[`Other${/}/.source}`] `` does not. A comment inside
the callee is one token, so `handlers['Other' /* + */ + 'Thing']` reads as
the same chain. A literal
anywhere else is an operand, not a name (`kind === 'date' && /\d/.test(s) ?
Date : RegExp`), and does not count. Names
end at identifier boundaries, so a constructor named `Code$` matches and
`x$ErrorCode` does not. The code
inside a template literal's `${...}` is scanned, at any depth. A `/` is read
as a regular expression where an operand would begin (after an operator, an
opening bracket, a keyword such as `return`, or the `)` that closes the head
of an `if`, `while`, `for`, `for await` or `with`) and as division after an
identifier, a number, a property name (a word after a single `.`, keyword
or not), any other `)`, a `]`, a literal or a postfix `++`/`--`. Each is read
from the significant tokens alone, so a comment between two tokens changes
nothing. After a `}` that closes a
block it could be either, so the gate stops with exit 2 rather than guess,
as it does on a regular expression, block comment or template literal that
never closes; parentheses around the expression settle it.

A lexer is not a parser, and a `/` read the wrong way hides the code after
it inside what then looks like a regular expression or a string. So a
`new <Constructor>`, with or without an argument list, in what the lexer read
as a comment or a literal is reported too, marked as such: if it is code, rewrite the line before it so
it reads as code; if it is text, reword it. The allowlist does not cover
it, because whether it is text rests on the lexer's reading, and an
exception granted to prose would cover the same construction on a line the
lexer misreads. Text shaped like a construction is never passed in silence.

A construction's identity is the literal it passes as the whole first
argument (`SYS-001`). A computed, composed (`'ORD-001' + suffix`) or missing
first argument has the identity `?`. Tests (`*.test.*`, `*.spec.*`,
`__tests__/`) and type declarations are not scanned: a test may build a code
of its own.

Every path given must hold at least one file the gate scans; a path with
none (empty, mistyped, or holding only tests or other extensions) stops the
gate with exit 2, even when another path holds files. A path wholly under a
`--registry` path is accounted for.

### The allowlist

Existing debt is listed by identity, one line per file, under a `#` comment
giving the reason:

```text
# Constructions from before the registry; each leaves when its code moves in.
src/orders/service.ts:?,ORD-001
src/billing/invoice.ts:BIL-004
```

Identities are sorted within a line. An entry covers constructions in code
only, and is checked for exact equality with the ones the file holds now: a construction fixed and another added leave
the entry stale, where a count would not move. A stale entry, an entry for a
file the scan does not reach, and an entry without a reason are findings, so
the list only shrinks on purpose. Keep it at zero where you can: the pass
line says how much debt the list carries.

### Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | No construction outside the registry beyond the allowlist | `OK — <n> file(s) construct no <Constructor> outside the registry`, and the debt the allowlist carries when it is not zero |
| 1 | Findings | one `[inline-error-code]` line per construction with its file and line, or an `[inline-error-code-allowlist]` line per stale or unreasoned entry, each with the remedy |
| 2 | Could not check | a message on standard error: a path, the registry or the allowlist missing or unreadable, a path that holds no source file to scan, a file the lexer cannot read, a malformed allowlist, a bad option |

### What it does not see

An alias (`const Code = ErrorCode; new Code(...)`) and a factory that wraps
the constructor are not matched. The lexer does not parse JSX (the
HTML-like markup syntax some JavaScript and TypeScript files embed): an
apostrophe in that markup's text (`<p>don't</p>`) opens a string that runs
to the end of its line, so a construction later on that line is reported as
text rather than as code. The
stronger form of the rule is visibility: a constructor the registry's module
does not export cannot be called elsewhere, and the gate is then only for
the places that must see it.

## `audit-error-codes.ts`: orphans and reverse orphans

```bash
bun audit-error-codes.ts --codes <file> --format <regex> \
  [--registry <path>]... [--docs <path>]... [--generated <glob>]... \
  [--baseline <file>] [--root <dir>] [--ext <list>] \
  [--docs-ext .md,.mdx,.txt,.html] <source path>...
```

- `--codes` — the registered codes, one per line: the code, then optionally
  the text a reference to it is written as (a constant's qualified name,
  `ErrorCodes.NOT_FOUND`). `#` lines are comments. Produce it from the
  registry, never by hand: from the data form
  ([`templates/error-codes.yaml`](../../templates/error-codes.yaml)),
  `yq -r '.codes[] | "\(.code) ErrorCodes.\(.name)"' error-codes.yaml`; from
  a code module, a one-line script that imports it and prints each
  constant's code and name.
- `--format` — the code format as a regular expression without anchors
  (`[A-Z]{2,5}-[0-9]{3}`). Every registered code must match it, and it is
  what the documents are searched for.
- `--registry` — a file or directory left out of both scans: the declaration
  is not a reference. Repeatable.
- `--docs` — hand-written documents to search for code-shaped literals the
  registry lacks. Repeatable; a generated reference needs no checking. Each
  path given must hold a document with one of the `--docs-ext` extensions,
  or the audit stops with exit 2.
- `--generated` — a glob, relative to `--root`, for source files generated
  from the registry (`packages/client/src/error-codes.ts`,
  `**/generated/**`). Repeatable. A source file whose first ten lines carry
  `@generated` or `DO NOT EDIT` is treated the same way without a glob.
- `--baseline` — accepted orphans, described below.
- `--root`, `--ext`, `--docs-ext` — as above; the source extensions default
  to the common languages' and the document extensions to Markdown, text
  and HTML.
- The source paths are scanned for references; tests, type declarations and
  generated copies are left out. Each path given must hold at least one
  source file; one wholly under `--registry` or wholly generated is
  accounted for.

A registered code is referenced when its literal, or its name, appears in a
source file on its own (`RES-001` is not found in `RES-0010`;
`Codes.NOT_FOUND` is not found in `Codes.NOT_FOUND_AGAIN`). A generated copy
of the registry (a client's union of codes, a runtime array, a message
catalog) names every code, so it is not evidence that any of them is used;
pass each with `--generated`, or give it a generated header. An
[orphan](../../../../GLOSSARY.md) is a registered code with no reference. A
[reverse orphan](../../../../GLOSSARY.md) is a match of the format in a
document that no registry entry declares. The scan is textual: a comment
that names a code counts as a reference, so the audit under-reports where
codes are written in comments; a parser-based audit tightens that.

### The baseline

An orphan that stays on purpose (a code reserved for the next release, a
code a client still handles while the server no longer throws it) is
accepted by identity, one code per line, under a `#` comment giving the
reason. An entry without a reason, for a code the registry does not declare,
or for a code that is referenced after all, is a finding, so the baseline
only shrinks. Reverse orphans have no baseline: the fix is a line in a
document.

### Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Every registered code is referenced or accepted, and no document names an unregistered code | `OK — <n> registered code(s), every one referenced; <m> documentation file(s) name no unregistered code` |
| 1 | Findings | `[orphan-error-code]` per orphan, `[unregistered-error-code]` per document line naming an unregistered code, `[orphan-baseline]` per stale or unreasoned entry, each with the remedy |
| 2 | Could not check | a message on standard error: the list, a path or the baseline missing or unreadable, an empty or malformed list, a code outside the format, a format that is not a regular expression, a source or documentation path that holds no file to scan, a bad option |

## Wiring

Both gates run on every pull request, after the generated copies' own drift
checks ([M2](../../../M2-generated-artifact-freshness/README.md)), and the
audit also over the documentation tree:

```bash
bun check-no-inline-codes.ts --registry src/errors/registry --allowlist .config/inline-error-codes.txt packages apps
bun audit-error-codes.ts --codes error-codes.txt --format '[A-Z]{2,5}-[0-9]{3}' --registry src/errors/registry --generated 'packages/client/src/generated/**' --docs docs --baseline .config/orphan-error-codes.txt packages apps
```

A finding is fixed in the code or the registry, never by widening a list:
a new allowlist or baseline entry is a reviewed decision with its reason
beside it.

## Fixtures and the self-test

`fixtures/` holds a registry (`registry/`), a registered-codes list
(`codes/`), a tree that passes (`clean/`), one that constructs codes inline
(`inline/`, with an allowlist that covers it, a stale one, one without a
reason and a malformed one), one with an orphan (`orphan/`, with the three
kinds of baseline), generated copies that name every code (`generated/`, one
by its header and one for a `--generated` glob) and documents naming a code
the registry lacks (`reverse/`). `error-registry.test.ts` runs both gates
against them for each of the three outcomes and tests the matching rules
directly (a construction in a comment, a string, a template expression or
after a regular expression, a literal inside a longer one, an allowlist's
multiset difference). Run it from a Jig checkout with
`bun test ./error-registry.test.ts`.
