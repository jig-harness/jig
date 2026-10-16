# Quiet run

Part of [M12 Parallel-agent ergonomics](../../README.md), core piece 8.

A gate command that an agent runs is read by the agent, line by line, and a
clean test run or lint prints hundreds of lines that say nothing the agent
needs. Piping the run through a filter (`| tail`, `| grep`) is the obvious
fix and the wrong one: the pipe's status is the filter's, so a failing suite
comes out as a pass. `quiet-run.ts` runs the command with its output
captured, prints a one-line verdict and the last few lines when it passed,
prints everything when it failed, and exits with the command's own status.

## Usage

```bash
bun quiet-run.ts [--name <part>] [--tail <n>] [--] <command> [args...]
```

- `--name` — the part's name in the verdict line; default the command's
  base name.
- `--tail` — how many of the last lines a passing run shows; default 25.
- `--` is optional: options end at it, or at the first word that is not one.

The script imports `lib/cli.ts` from the Jig repository, so run it from a
pinned Jig checkout or vendor `lib/` with it.

## The verdict line

Every run ends with one line a reader can grep for, on green and on red:

| Outcome | Last line | Exit |
| --- | --- | --- |
| passed | `<name>: passed — <n> line(s) condensed, last <k> shown` | 0 |
| failed | `<name>: FAILED (exit <code>)` | the command's code |
| could not run | `<name>: could not run — <reason>` | 2 |

A run with several parts calls the wrapper once per part, each with its
`--name`, so the reader counts one verdict line per part. A part without a
verdict line did not run; it never counts as passed.

A passing run's tail keeps what the command wrote to standard error too
(a linter's warnings), since a green run with warnings is still green and the
warnings are the part worth reading. A failing run prints standard output
and standard error on their own streams, then the verdict.

## Exit codes and fail-closed cases

The command's exit code passes through unchanged, so a child's own could
not check (exit 2) stays 2. The wrapper's own 2 covers a usage error, an
executable that was not found, a child killed by a signal and the wrapper
itself cancelled; in the last two cases the output the child wrote is
printed, not dropped, and the verdict says what ended the run. A
cancellation of the wrapper (SIGINT, SIGTERM, SIGHUP) is passed to the
command and every process it started (on POSIX, its process group), and
whatever is still running ten seconds later is killed, so cancelling the
wrapper stops the whole run. How long a run that is never cancelled may
take is the caller's bound, not the wrapper's.

The output is spooled to temporary files, not held in memory, so a verbose
run cannot exhaust the wrapper; only the requested tail of a passing run is
read back, as whole lines, and at most 4 MiB of it: the lines before that
bound are replaced by one line saying how many bytes were not shown, and a
last line longer than the bound by one saying so.
A failing run's streams are each printed to the end of a line, so the
verdict always starts its own line. Standard input is passed through to the
command.

Never wrap a command that does not exit on its own (a watch mode, a dev
server, a debugger waiting for a connection): the verdict comes only when
the command ends. A runtime hook that applies the wrapper
automatically therefore rewrites only a plain invocation of a known runner
and passes everything else through untouched; the shape of that hook is in
[mappings.md](../../mappings.md#agent-facing-gate-output).

## Self-test

`quiet-run.test.ts` runs the wrapper over the fixtures (a passing run, a
silent pass, a pass with warnings on standard error, a failing run, a gate
that could not check, a run killed by a signal, output that does not end its
last line, input on standard input, a run longer than one read of the spool,
the wrapper cancelled) and checks the verdict line, the exit status and the
tail. Fixtures are commands, not data, so each is a
small script the test runs with the same runtime.
