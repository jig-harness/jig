# Classified retry

Part of [M1 Gates and the enforcement ladder](../../README.md), the
gate-authoring rule "classify before retrying" (core piece 3).

A step that retries every failure turns a permanent error (a missing
permission, a wrong name, an expired credential) into minutes of waiting,
then reports the timeout instead of the error, so whoever reads the log
fixes the wrong thing. A step whose retry matches guessed wording never
retries at all, because the tool's real message differs from the guess.
`retry-classified.ts` runs a command and retries it only when its output
matches a pattern the repository has classified as transient, with the
reason beside the pattern; anything else aborts at once with the command's
own output and exit code. Its `--classify` mode answers for one message, so
the pattern list is tested against messages recorded from the real tool.

## Usage

```bash
bun retry-classified.ts --transient <patterns> [--permanent <patterns>] [--attempts 3] \
  [--delay-ms 2000] [--max-delay-ms 60000] [--] <command> [args...]
bun retry-classified.ts --transient <patterns> [--permanent <patterns>] --classify < message.txt
```

- `--transient` — the pattern file (below); required.
- `--permanent` — a second pattern file, in the same form, of errors that
  are never retried; a line matching one makes the failure permanent even
  when another line of the output looks transient.
- `--attempts` — how many times the command may run; default 3, at least 1.
- `--delay-ms` — the pause before the second attempt; default 2000. It
  doubles before each later attempt.
- `--max-delay-ms` — the ceiling of that doubling; default 60000, not below
  `--delay-ms`. A tool that says how long to wait (a rate limit's "retry
  after 32 seconds") is paced by setting `--delay-ms` to that wait.
- `--classify` — read a message from standard input and print whether a
  transient pattern matches (exit 0) or none does (exit 1); for tests.
- `--` is optional: options end at it, or at the first word that is not one.

The script imports `lib/cli.ts` and `lib/findings.ts` from the Jig
repository, so run it from a pinned Jig checkout or vendor `lib/` with it.

## The pattern file

A line-based list in the form M1 uses for every exception list
([mappings.md](../../mappings.md#exceptions-that-prune-themselves)): `#`
lines give the reason for the patterns under them, a blank line ends the
group, and each other line is one extended regular expression tested
against every line of the command's output (standard error first, then
standard output). A permanent list wins over the transient one: a command
that prints an earlier rate-limit warning and then fails for a missing
permission failed for the permission. Without a permanent list, any line
that matches a transient pattern authorizes the retry, which the attempt
count bounds. A pattern without a reason, a pattern that does not
compile, and a file with no pattern each fail the run (exit 2): a list that
classifies nothing as transient would retry nothing, and a reason is what
lets a later reader prune a pattern the tool no longer emits.

Anchor a pattern to the tool's stable prefix (`^error: API rate limit
exceeded`) rather than a bare word that an unrelated message may contain.
Record the real message in a fixture file under `fixtures/recorded/` and
assert the classifier's answer for it in the self-test; wording written from
memory is the failure this reference exists to prevent.

## Exit codes and fail-closed cases

| Exit | Meaning |
| --- | --- |
| 0 | an attempt passed |
| the command's code | it failed for good: an error not classified as transient (no retry), or the last attempt still transient; the output is printed as the command wrote it, then one line on standard error saying which |
| 2 | the wrapper could not decide: a usage error, a pattern file that is missing, unreadable, empty, without a reason or that does not compile, an executable that was not found, a child killed by a signal, an output line too long to classify, or `--classify` given an empty message |

A child's own could not check (exit 2) passes through unchanged and is
never retried, whatever its output says. A killed child is never retried:
the signal may have been the caller's cancellation. A cancellation of the
wrapper itself (SIGINT, SIGTERM, SIGHUP) is never retried: during an
attempt it is passed to the command and every process the command started
(on POSIX, its process group), which are killed if they are still running
ten seconds later; during the delay before the next attempt it ends the
wait at once. Either way the last attempt's output is printed and the
wrapper exits 2. A failure whose output holds a line longer than the
classifier reads is not cut to fit, which could drop a permanent match: it
is printed and not retried, exit 2. How long an attempt may run is the
caller's bound (the CI job's timeout), not the wrapper's.

The command's standard input is closed: a retried command cannot read the
same input twice, so a command that reads its input from standard input is
not one to wrap. Its output is spooled to temporary files rather than held
in memory, so a verbose command cannot exhaust the wrapper.

## Self-test

`retry-classified.test.ts` runs the wrapper over a flaky fixture command
that counts its own runs (transient then pass; a permanent error, which
must run once; a permanent error beside a transient-looking line; attempts
exhausted; the doubling delay; a child that could not check, also beside a
transient-looking line; a child killed by a signal; the wrapper cancelled),
classifies the recorded messages in `fixtures/recorded/` against both
lists, and fails each malformed pattern file. It asserts the
exit code through the repository's spawn helper so a mismatch prints the
child's output.
