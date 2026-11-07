# Fixed delays carry a reason

A gate that fails a fixed delay (a sleep, a timer) in the files it scans
unless the delay carries a `fixed-delay: <reason>` token, and fails a token
that no longer sits beside a delay. It turns
[M14](../../README.md)'s "poll, don't sleep" rule from a review habit into a
check that runs in a hook and in [CI](../../../../GLOSSARY.md).

Without it, a test that sleeps five seconds and hopes the work is done looks
like every other test: it passes while the system is healthy, wastes the
five seconds on every run, and when the system is slow it fails somewhere
else with a confusing assertion. A wait for external state should poll
against a deadline ([`poll-until`](../poll-until/) is a helper that does).
A fixed delay is right only for local timing: a retry back-off, an abort
deadline, the pause between two polls. The token says which, where the delay
is written, so a reviewer can tell a deliberate pause from a hopeful one.

## What it checks

In every text file it scans, line by line:

1. a line holding a delay needs a token on the same line or the line above.
   A token on the line above counts only when that line holds no delay: a
   token beside one delay does not also excuse the delay on the next line;
2. a token needs a reason: text after `fixed-delay:`, ending at the end of
   the line, at the next token or at a block comment's closing marker (`*/`,
   `-->`, `--!>`). Every token on a line needs one;
3. a token needs a delay on its own line or the line below. A token with no
   delay beside it excuses nothing: the delay it excused was replaced by a
   poll, or moved away. It fails, so it leaves with the delay instead of
   quietly excusing the next one written there.

A delay is one of a list of literal texts, by default `Bun.sleep(`,
`setTimeout(`, `sleep(` and `time.sleep(`. A text matches where the
character before it is not part of a name (a letter or digit in any script,
`_` or `$`), so `sleep(` finds `sleep(1)` and `asyncio.sleep(1)` but not
`oversleep(1)` or `résleep(1)`. The `fixed-delay:` token is matched the same
way, so a name ending in it is not a token.
The gate reads text, not code: a delay named in a comment or a string counts
too, so reword a comment that names one.

| Argument | Meaning |
|----------|---------|
| `<path, dir or glob>...` | the files to scan: a file, a directory (every file under it) or a glob read from `--root`; repeat for several. A directory or glob leaves out `.git` and `node_modules` |
| `--pattern <text>` | a delay text, literal, not a regular expression; repeat for several. Given once, it replaces the default list; an empty text is a usage error |
| `--exclude <glob>` | leave out the files it matches, relative to `--root` however the file was named; repeat for several |
| `--root <dir>` | where globs are read from, and what `--exclude` is relative to (default `.`) |

Exit codes: `0` every delay carries a token with a reason and every token sits
beside a delay; `1` at least one finding (each is listed with its file and
line, the problem and the fix); `2` the gate could not check: a usage error
(no file named, an empty pattern, an unknown option), an argument that
matches no file, a file it cannot read, or no text file left to scan once
the exclusions and binary files are left out. A run that examined nothing
never passes. On a green run it says how many files and delays it saw, and
which texts it looks for. Under GitHub Actions (`GITHUB_ACTIONS=true`) each
finding is also printed as an `::error` annotation on its line.

## Running it

```sh
bun check-fixed-delay.ts 'src/**/*.test.ts' 'scripts/**/*.ts' \
  --exclude '**/fixtures/**'
```

For a Python test tree, give the texts its delays use:

```sh
bun check-fixed-delay.ts 'tests/**/*.py' --pattern 'time.sleep(' --pattern 'asyncio.sleep('
```

The texts for other ecosystems, and the lint rules that do the same job
where one exists, are in the module's
[mappings](../../mappings.md#poll-dont-sleep). Run it in the pre-push hook
and in CI over the test and tooling code.

## The token

```ts
// fixed-delay: back-off between attempts at a flaky local resource
await Bun.sleep(2 ** attempt * 100);

const timer = setTimeout(abort, ms); // fixed-delay: abort deadline
```

```python
time.sleep(0.1)  # fixed-delay: the pause between two polls of the job
```

The token is an exception in the sense of
[M1](../../../M1-gates-enforcement-ladder/README.md): register it in the
suppression-token registry with this gate as its consumer, its placement
(the delay's line or the line above), the reason it requires and when it is
stale (no delay on its line or the line below).

## What it does not judge

It proves that each delay says why it is fixed, not that the reason is true:
"the queue needs a moment" is a reason the gate accepts and a reviewer should
not. A delay written in a way the texts do not name (a helper that wraps
`setTimeout` under another name) is not seen; name the wrapper with
`--pattern`.

## Files

| File | Role |
|------|------|
| `check-fixed-delay.ts` | the gate |
| `check-fixed-delay.test.ts` | self-test: justified delays on the line or the line above, a bare delay, a token without a reason, a stale token, a token two lines away, one token beside two delays, look-alike names, globs with `--root` and `--exclude`, custom texts, annotations, and every could-not-check case |
| `fixtures/` | small TypeScript, Python and Java files: `clean/` passes; `bare/`, `no-reason/`, `stale/` and `far/` each fail one way; `java/` holds a `Thread.sleep(` for the `--pattern` cases |

Run the self-test with `bun test ./check-fixed-delay.test.ts`. The gate has
no imports beyond Bun's and Node's built-ins, so it can be copied as it is;
the self-test imports Jig's spawn-exit helper from
`lib/test-helpers/expect-spawn-exit.ts`.
