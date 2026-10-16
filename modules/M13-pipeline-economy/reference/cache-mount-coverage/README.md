# Cache-mount coverage

Part of [M13 Pipeline economy](../../README.md), piece 8 (cache).

**What problem this solves.** A container build keeps its dependency store
on a build-time [cache mount](../../../../GLOSSARY.md) so that a rebuild
does not download every package again. The mount exists only for the one
`RUN` that declares it; nothing of it is committed to the image. A stage
that points the package manager's store at the mount's path therefore needs
the mount on every `RUN` that invokes the package manager, and the install
step is not the only one: a build step whose lifecycle script calls the
package manager again reads the same store, and without the mount it finds
an empty directory and fails, on every build, with an error that names a
missing package index rather than a missing mount. Which steps read the
store depends on scripts in other files, so the only rule decidable from
the Dockerfile is the one this gate checks: mount it on all of them.

`check-cache-mounts.ts` reads one or more Dockerfiles and fails when a stage
pins the store to a path and a `RUN` of that stage invokes the package
manager without mounting it, when two `RUN`s mount the store's path as
different caches, or when a `RUN` pins the store with the per-command flag
instead. It checks only; it changes nothing.

## Invariant

> A cache that a build step depends on is wired on every step that reads
> it. A cache wired on some steps serves stale or empty results on the
> others, and the failure names the wrong thing.

## Usage

```bash
bun check-cache-mounts.ts [--command pnpm] [--store-env npm_config_store_dir] \
  [--store-flag --store-dir] [--build-arg NAME=VALUE]... <Dockerfile>...
```

| Option | Default | What it is |
|--------|---------|------------|
| `--command` | `pnpm` | the package manager's command name as a `RUN` spells it; a path (`/usr/local/bin/pnpm`) matches by its last segment |
| `--store-env` | `npm_config_store_dir` | the stage-level variable that pins the store's path, which every later process of the stage inherits |
| `--store-flag` | `--store-dir` | the per-command flag that pins the store for one process only |
| `--build-arg` | none | a build argument as the build passes it (`docker build --build-arg`), repeatable; needed when the store is pinned by `ARG` |

The defaults are pnpm's; `mappings.md`'s [cache rows](../../mappings.md#cache)
give the triple for other package managers (`pip` with `PIP_CACHE_DIR` and
`--cache-dir`, for one). Run the gate once per package manager a Dockerfile
uses.

The script imports helpers from the Jig repository's `lib/` (`cli.ts`, the
exit-code boundary, and `findings.ts`), so run it from a pinned Jig checkout
rather than copying it.

## Rules

Each finding names its rule, the file and line, the problem and the fix.

### cache-mount-missing

In a stage whose store is pinned to a path by `ENV <store-env>=<path>` or by
a build argument `ARG <store-env>` (an environment variable to the `RUN`s of
its stage), every `RUN` that invokes the command carries
`--mount=type=cache,target=<that path>` (`dst=` and `destination=` are the
same key; a trailing slash is ignored). The pin applies to the `RUN`s after
it. A build argument's value is the one the build passes, which a default in
the Dockerfile does not establish (`--build-arg` overrides it), so the gate
reads it from its own `--build-arg`; without one, an `ARG` pin stops the
check once a `RUN` of the stage invokes the command. A stage inherits both
pins from the stage it builds `FROM`, and `ENV` outranks `ARG` for the same
name. A command's own `<store-env>=<path>` prefix (or `env <store-env>=<path>`)
pins the store for that command and for every command it runs (its `-c`
body, its `eval` text). A stage that pins nothing is outside the rule: its
mounts, if any, are the reviewer's.

### cache-id-mismatch

Within one stage lineage (a stage, the stage it builds `FROM` and the stages
built from it), every cache mount of a store's path is the same cache. A
mount's `id` names the cache and defaults to its target, so an install that
mounts `id=deps,target=/store` and a build that mounts `target=/store` (or
`id=other,target=/store`) read two different caches: the build finds the
store empty although its mount is there. Every store a `RUN`'s invocations
read is checked, the stage's pin and any a command sets for itself.
Unrelated stages may keep their own caches on the same path.

### store-flag

No `RUN` pins the store with the per-command flag (`--store-dir <path>` or
`--store-dir=<path>`). A flag binds one process; a child process the command
spawns (a lifecycle script that calls the package manager again) inherits
nothing and falls back to the default store: the two steps then read
different stores. The stage-level variable is inherited by every descendant
process.

## What it reads

A `RUN` is read as the shell runs it, not as text: an invocation inside
`&&`, `||`, `;`, a pipe, a subshell or a substitution, behind an `if`, a
loop or a `case` branch, after `VAR=value` prefixes and redirections
(`> log`, `2>&1`), through a transparent wrapper (`env`, `sudo`, `nice`,
`timeout`, `exec`, `command`, `nohup`, `time`, with the options the reader models,
values separate or attached), by
path, in an exec-form `RUN ["pnpm", …]` (through the same wrappers), in the
literal body of an interpreter's `-c` (options combined or not: `sh -ec`,
`bash -o pipefail -c`), or in `eval`'s literal text, is found; a word that
only mentions the command (`echo pnpm`) is not. A command substitution, in
`$(…)` or backquotes, quoted or not, is read as its own commands, and the
command around it keeps the arguments after it. Continuation lines join as
Docker joins them (the backslash and the line break removed), with comments
and blank lines inside them dropped.

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Every invocation in a pinned stage is mounted and none pins by flag | `OK — <n> Dockerfile(s), <m> stage(s), <k> <command> invocation(s) checked`, with a note when no stage pins the store |
| 1 | At least one finding | each finding on standard error (`file:line: [rule] problem`, then `fix: …`); under GitHub Actions also as an `::error` annotation |
| 2 | Could not check | the reason on standard error |

It fails closed: no Dockerfile given, one that cannot be read or is empty,
one with no `FROM`, one that ends inside a continuation line, an `escape=`
directive other than the backslash, a `RUN` option other than `--mount`,
`--network` and `--security` (`--device`), a `RUN` with a heredoc body, an
unterminated quote or command substitution, a `RUN` whose command is an
expansion (`$PM install`, `$(cat pm) install`), an interpreter's `-c` whose
body is not a literal or whose options are not read up to the `-c`, a
`SHELL` that is not a POSIX shell (`SHELL ["pwsh", …]`) or that carries an
operand among its options (`SHELL ["bash", "-c", "pnpm i", "-c"]`) before a
shell-form `RUN`, a pin of several words in `ENV`'s one-pair form
(`ENV npm_config_store_dir /s extra`), an argument of the command whose
expansion can pass the store flag (`pnpm install $FLAGS`, `"$P"`; a literal
before the expansion that rules the flag out, as in `--filter "app-$P"`, is
read), a cache mount that names no target or whose target or id is an
expansion (`target=${STORE}`), a pin set to an expansion
(`ENV npm_config_store_dir=$STORE`) or given as a build argument the gate was
not given with `--build-arg`, or a `FROM` whose image is an expansion
(`FROM ${BASE}`) while a stage pins the store, or a wrapper option the
reader does not model (`env --frobnicate`, `sudo -i`, combined short options
such as `env -iu`), each exit 2. In a stage that
pins the store, so is a `RUN` that sets, exports or unsets the store's
variable for the commands after it, runs the command with the variable
removed (`env -i`, `env -u`, `exec -c`, `sudo` without `-E` or a
`--preserve-env=` list naming it), directly or around a `-c` body, or set
to an expansion,
or hands a shell its script on standard input (`… | sh`, `bash <<<…`), or
calls a function it defines with a store other than the one where the
function is defined (`deps() { pnpm i; }; npm_config_store_dir=/o deps`;
setting the pinned path again is the same store), or defines a function
named for a command the reader models (`env`, `sudo`, `time`, a shell,
`eval`, `export`, the package manager), since its calls are then not that
command. Definitions are found in the shell's syntax, so a function name in
quoted text or a comment defines nothing. A
spelling the reader does not model is a reason to stop, never a reason to
pass: an invocation this gate misses is a hole in the rule, not a
conservative decline.

## Known limits

It reads the Dockerfile alone. It cannot tell which commands read the store,
which is why it requires the mount on every invocation. A command reached
through a script file, `xargs`, `find -exec` or a wrapper it does not list
is not seen; list the wrapper's call plainly, or add it to the wrappers. A cache mount
in a stage that pins no store, and a mount whose target the command's
defaults do not read, are the reviewer's: whether a declared cache stores
anything is the hit-rate report's question ([M13 piece 8](../../README.md#8-cache)).

## Files

| File | Role |
|------|------|
| `check-cache-mounts.ts` | the gate: options, Dockerfile and shell reading, the rules, the report |
| `check-cache-mounts.test.ts` | paired self-test |
| `fixtures/` | one Dockerfile per case: a pass across inherited stages and every invocation shape, a partially wired stage, a stage pinned by a build argument (checked with and without its `--build-arg`), a flag pin, no pin, and the unreadable forms (heredoc, dynamic command, dynamic pin, dynamic base image, dynamic mount target, empty); the self-test adds one case per shell spelling it reads or refuses |
