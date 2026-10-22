# Toolchain pins

Part of [M2 Generated-artifact freshness](../../README.md).

A toolchain version (the runtime, the compiler, the package manager) is
declared once, in the file the developers' version manager reads, and then
repeated wherever something installs the tool on its own: a CI setup step, a
container build argument, a package-manager field, a type package that
tracks the runtime. Each copy is a pin site, and pin sites drift: one is left
out and floats to the tool's latest release, one is missed by an upgrade and
stays a version behind. Code then runs under one version in CI, another in
the container and a third on a laptop, and the difference shows up as a
failure nobody can reproduce.

`check-toolchain-pins.ts` reads a declaration of each tool's one source and
its pin sites and fails when any pin differs from the source. It is the
module's rung 2 (check in CI, commit nothing) applied to a version: nothing
is generated, the copies are checked. It only detects; it changes nothing.

## Usage

```bash
bun check-toolchain-pins.ts [--root <dir>] <declaration.yaml>
```

- `--root` — the directory the declaration's paths are relative to; default
  the working directory.

The script imports helpers from the Jig repository's `lib/` (`cli.ts`,
`files.ts`, `findings.ts`, `record.ts` and the vendored YAML parser), so run
it from a pinned Jig checkout, or vendor `lib/` with it; a lone copy leaves
imports that do not resolve.

## The declaration

```yaml
tools:
  bun:
    source: { file: mise.toml, toml: tools.bun }
    sites:
      - { files: package.json, json: packageManager, pattern: '^bun@(.+)$' }
      - { files: package.json, json: devDependencies.@types/bun }
      - files: .github/workflows/*.yml
        step: oven-sh/setup-bun
        with: bun-version
        with-file: bun-version-file
      - { files: Dockerfile, pattern: '^ARG BUN_VERSION=(\S+)$' }
    exceptions:
      - file: .github/workflows/runtime-canary.yml
        value: canary
        reason: runs the suites on the next release on purpose
```

One entry per tool. `source` names one file and how to read the version from
it; `sites` lists every other place the version is repeated, each with
`files` (a glob, or a list of globs, relative to the root) and how to read
it; `exceptions` registers the values that differ on purpose. A repository
declares the sites it has and nothing else: a glob in `files` that matches
no file is a declaration that is out of date, and the check does not pass
it.

### Readers

A source and a site are read the same way:

- `toml:`, `json:` or `yaml:` followed by a dotted path reads one value (a
  string or a number) from a structured file, and every file the site names
  must hold it: a file where the path finds nothing is a pin that is gone. A
  key that contains a dot cannot be addressed this way; read it with a
  pattern instead.
- `step:` names a CI setup action without its `@ref` (`actions/setup-node`)
  and `with:` the input that holds its version (`node-version`). The site's
  files are parsed as GitHub Actions workflows or composite actions, and
  every step that uses the action is a pin: a step whose input is missing
  has no version, and a step in a comment is no step. `with-file:` names the
  input that reads the version from a file instead (`node-version-file`),
  which the action uses only when the version input holds none, so a step
  that sets both is read by its version. A step that reads a file agrees
  when it names the source file and the action, read the way its own
  source reads that file, takes the source's value from it. The check
  carries that reader for `actions/setup-node` (a text file by its
  pattern, when no release of the action reads it as JSON or TOML) and
  `oven-sh/setup-bun` (`.bun-version`, `.bumrc` and `.tool-versions` by
  name, nothing else). It is a finding when the step names another file,
  when the action reads another value from the source, when it reads the
  file in a way the check does not follow (a JSON file such as
  `package.json` or a TOML file such as `mise.toml`, which setup-node reads
  by their fields, or a name setup-bun does not read), and for any other
  action, whose reader the check does not carry:
  there nothing confirms which value the action installs, so set the
  version input explicitly. Read a setup step this way rather than with a
  pattern over the workflow's text, which a comment or a string satisfies
  and which cannot see a step whose version input was removed.
- `pattern:` is a regular expression whose first capture group is the
  version. On its own it is applied to the whole text of each file the site
  names, line by line (`^` and `$` match at line ends), and every match is a
  pin. Beside a path or step reader it is applied to the value that reader
  read, which is how `packageManager: bun@1.4.3` yields `1.4.3`. Use it on
  its own for files that are text, such as a `Dockerfile` or a version file,
  and anchor it at the line start (`^ARG BUN_VERSION=`) so a comment does
  not match.
- A match whose capture group did not take part, and an empty or blank
  value, is a pin site with no version, and a finding: the tool floats to
  its default, which is usually its latest release. A value a path found that the pattern beside it
  does not read at all (`packageManager: pnpm@9.0.0` against `^bun@(.+)$`)
  is reported as that, naming the value and the pattern, not as a floating
  version: the field pins another tool, or the pattern is wrong.

Values are compared as text, with no version arithmetic: `v24.3.0` and
`24.3.0` differ, so the pattern strips what a site adds (`^v?(\S+)$`). A
range (`engines`, a minimum in a project file) is not a pin and does not
belong in the declaration: it stays true across an upgrade, and the install
checks it. Where a type package tracks only the runtime's major version,
declare a second tool whose source and sites are read with a pattern that
captures the major.

### Exceptions

An exception names a `file` (an exact path relative to the root), the
`value` it allows there and a non-empty `reason`. It excuses every pin of
that value in that file, and nothing else: the file's other pins are still
checked. Where one file holds several pins of the tool, an exception may also
name the `toml:`, `json:` or `yaml:` path of one site, and then excuses only
the pin read through it: a package file whose type package lags the runtime
is excused at `json: devDependencies.@types/bun`, so its `packageManager`
pin set to the same value is still a finding. An exception prunes itself. One whose value is the source's value
now, and one that no pin holds, excuse nothing, and each is a finding, as
[M1](../../../M1-gates-enforcement-ladder/README.md) asks of every
exception.

## Exit codes

| Exit | Meaning | Output |
| --- | --- | --- |
| 0 | Every pin equals its source | one line per tool: `OK — <tool>: <n> pin(s) equal <source>'s <value> (<m> file(s) read[, <k> exception(s) registered])` |
| 1 | At least one finding | per finding, its place, `[toolchain-pins]`, the problem and a `fix:` line; then a count; under GitHub Actions, an `::error` annotation on the line too |
| 2 | Could not check | a message on standard error |

The findings: a pin that differs from the source; a site with no version; a
setup step that reads its version from a file other than the source; a path
site file that does not hold the pin, and a step or pattern site whose files
match but hold no pin at all (the pin the declaration knew about is gone);
an exception whose value is the source's now; an exception no pin holds.

The script fails closed. A declaration that is missing, empty, not YAML or
malformed (a source or site without a reader or with two, a step without
its input or with an `@ref`, a site with no files, an exception without a
reason, a pattern that does not compile), a source file that is missing or
holds no value where the reader looks, a source that holds more than one
value, a site glob that matches nothing,
and a site file that cannot be read or is not its declared format all exit
2: nothing the check could not read passes.

## Running it

Run it in CI on every change, and in the pre-push hook if the repository has
one; it takes well under a second. Jig runs it on itself: the declaration is
`.config/toolchain-pins.yaml` at the repository root, `bun run pins` runs
it, and the gates (`bun run gates`, fast and full) include it. The sites a
repository commonly has, per ecosystem, with the pattern that reads each,
are in [the module's mappings](../../mappings.md#toolchain-pin-sites).

An upgrade changes the source and runs the check, which lists every site to
follow. A pin the repository holds at another value on purpose, such as the
[runtime canary](../../../M14-testing-strategy/README.md) that runs the
suites on the tool's next release, is registered as an exception with that
reason.
