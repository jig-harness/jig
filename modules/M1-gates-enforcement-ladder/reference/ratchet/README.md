# Ratchet gate

A [ratchet](../../../../GLOSSARY.md) lets a codebase keep the findings it
already has while refusing any change that adds to them. Without one, a team
that turns on a stricter rule has two bad choices: fix every existing finding
first, or leave the rule off. With one, the rule goes on today, new code meets
it, and the existing count falls as code is touched. The same rule applies
to source-file size: split code by responsibility and keep the total lines
above the chosen limit from growing, including in test files.

## How it works

- **Severity is the declaration.** A rule at `error` is enforced by its own
  tool. A rule at `warn`, or a compiler flag listed only in a separate
  project file (Jig's `tsconfig.ratchet.json`), is ratcheted. Nothing else
  lists which rules are ratcheted.
- **The base is derived, not stored.** The gate checks out the
  [merge base](../../../../GLOSSARY.md) with the target branch in a temporary
  git worktree and measures it and the working tree with the same commands,
  using the head's configuration, support files and installed tools for both.
  A tool upgrade or a newly ratcheted rule therefore moves both counts alike.
  No baseline file is committed, so parallel pull requests that remove
  findings never conflict over one.
- **File size counts excess lines.** The `file-lines` counter sums
  `max(0, physical lines - limit)` under `excess-lines` across tracked and untracked files
  matching its `files` regular expression, except those matching `exclude`.
  Blank lines count; a final newline terminates the last line. This catches
  growth inside an already oversized file. Choose a source-and-test scope
  and exclude generated and vendored outputs; prose need not share a code
  limit. Untracked files obey Git ignore rules. A scope that matches no file
  in the working tree is a configuration error (exit 2), so a mistyped
  expression cannot pass as a tree without excess. A merge base that predates
  every matching file counts zero excess.
- **Totals per rule are compared**, not per-file counts, so moving code
  between files passes. When a total grows, the files whose counts grew are
  listed. A `json` counter with `per: "file"` makes each file's count its own
  ceiling instead, for rules about one file's own content (a skill's
  structure, say), where moving a finding to another file is no fix.
- **Loosening is checked on its own.** Because both trees are measured with
  the head's configuration, a change that loosens a rule would pass the count
  comparison. Two checks catch it, and either passes only when a commit in the
  range carries the trailer `Ratchet-Loosen: <name>: <reason>` in its last
  paragraph, where git reads trailers (the failure message names the `<name>`
  to give):
  - *measured*: the base is also counted under its own configuration. A rule
    that finds less in the base under the head's configuration was loosened,
    however that was done: a lower severity, an override, an excluded path, an
    edited lint plugin, a compiler flag. Errors count here as well as
    warnings, so promoting a rule to an error is not a loosening. When the
    base's own configuration cannot be measured for a counter the base's
    wiring already had, that is itself a loosening, since this check cannot
    run; for a counter new in this change it is skipped;
  - *declared*: a rule, plugin, preset or compiler flag that a configuration
    file sets less strictly than the base did, and a rule named only to switch
    it off. This covers rules that have no findings to measure. An override
    that sets a rule below its rank outside the override (named
    `<rule>@<files>`) counts, and so does a narrowed file scope: a pattern
    dropped from, or an exclusion added to, the files, the linter's or a
    plugin's `includes` (named `includes`). A plugin is named by its file,
    so one moved to another directory under the same name keeps its
    strictness, as a rule that graduates to another group does; a
    configuration listing two plugins with one file name is refused, since
    the two could not be told apart. Where a later entry decides
    over an earlier one (Biome's `includes` patterns and its overrides), the
    entries both trees share must keep their order: moving one counts, named
    by the file's path. Biome's presets rank `none`, `recommended`, `all`,
    globally and per override. Compiler configurations are resolved through
    their `extends` chain as the compiler resolves them (a relative parent
    with or without `.json`, a package's configuration, a later parent over
    an earlier one, `references` kept to the file that sets them); a parent
    that cannot be found, or a chain that extends itself, is an error, and
    `strict` counts for the flags it implies;
  - *unranked*: everything else a configuration file sets — a compiler
    configuration's other options and the files it covers, a linter's ignore
    and file settings, a rule's options, a whole rule group switched off — is
    not ranked, so for a file the base's wiring already compares, any change
    to it counts, named by the file's path. Formatting settings are left out.
    A file wired for the first time is compared on its ranked settings only.

  Compiler findings measured as lost are accepted only when every change to
  the compiler configurations carries its own trailer, so nothing but
  approved changes can have caused the loss.

  A rule that moves from one group to another (a lint rule graduating from an
  experimental group) keeps its strictness and is not a loosening. In the
  ratchet's own wiring, removing a counter, a configuration file or a support
  path, adding or widening a support path or a configuration file over a
  path the base already has, or changing a counter's format,
  command, file filter or patterns, raising a file-line limit, or dropping
  a json counter's per-file comparison, is one.
  Lowering that limit tightens the rule; both trees use the new limit. Configuration files and support
  paths are copied over the base, so the findings inside them are not
  compared: keep them to what the configuration needs.
- **Promotion.** When a change brings a ratcheted rule to zero, the gate says
  so: the next step is to make that rule an `error`. For compiler output,
  whose findings are error codes rather than settings, the unit is the whole
  counter. File-line counters stay in the ratchet at zero, where any excess
  line then fails.
- **A missing base** (a shallow clone, an unknown branch) is reported and the
  comparison skipped locally; in CI (`CI` set) it fails, because the gate
  would otherwise pass without having compared anything.
- **The base checkout runs nothing.** The worktree is added with no hooks and
  without large-file downloads, and stale worktrees from an interrupted run are
  pruned.
- **Unreadable output fails.** A compiler run that exits with an error but
  names no file (a missing project, a bad option) stops the gate instead of
  reading as zero findings.

## Configuration

`ratchet.ts --config <file> [--base <ref>] [--report]`. The base defaults to
`RATCHET_BASE`, else `origin/main`. `--report` prints the current counts
without comparing. Exit 0 passes, 1 means a count grew or a rule was
loosened, 2 is a usage or configuration error.

The configuration file (JSON, comments allowed) wires the commands:

| Key | Meaning |
|-----|---------|
| `counters[]` | `{ name, format, command }` for `biome-json` (Biome's `--reporter=json`; every warning counts, plugin findings by the `<scope>/<name>:` prefix of their message) or `tsc` (`--pretty false` output, counted per error code); or `{ name, format: "grep", patterns, files? }` to count regular-expression matches in the repository's files. or `{ name, format: "file-lines", limit, files, exclude? }` to count excess physical lines in tracked and untracked source files. `limit` is a positive integer; `files` and `exclude` are regular expressions. Or `{ name, format: "json", command, per? }` for any counting command that prints `{"counts": {"<rule>": {"<file>": n}}}` and exits 0; other output, or another exit code, stops the gate. `per: "file"` compares each file's count rather than the total; dropping it is a loosening. A json counter keeps its counts with no promotion to suggest, and its measured-loosening check compares rules by the names the command prints, per file when `per: "file"` is set, with a trailer naming the counter. Names are unique |
| `configs[]` | `{ path, kind }` with `kind` `biome`, `tsconfig` or `fallow`: the files compared for loosening |
| `support[]` | Further paths the head's configuration needs in the base tree (plugin directories, extended configs). Each is copied over the base, so the findings inside it are not compared. Paths in `configs[]` and `support[]` are relative, with forward slashes and no `.` or `..` segment; any other form is refused |

Jig's own wiring is [`tools/quality/ratchet.jsonc`](../../../../tools/quality/ratchet.jsonc),
run by `bun run quality`.

## Files

| File | Role |
|------|------|
| `ratchet.ts` | The gate and comparison flow |
| `ratchet-config.ts` | Configuration parsing and strictness comparisons |
| `ratchet-common.ts`, `ratchet-types.ts` | Shared file readers and data contracts |
| `ratchet-json.ts`, `ratchet-json.test.ts` | A counting command's JSON and what a changed command loses, and their self-tests: per-file growth fails where totals pass, a counter new in the change is measured with the head's command, unreadable output stops the gate, and dropping per-file comparison, a command that finds less, or one that moves findings to another file needs a trailer |
| `ratchet-file-lines.ts` | Excess-line measurement |
| `ratchet-file-lines.test.ts`, `ratchet-parsers.test.ts`, `ratchet-test-support.ts` | File-size tests, parser and strictness tests, and scratch-repository helpers |
| `ratchet.test.ts` | Self-tests against scratch repositories: growth fails, moves pass, promotion is reported, loosening (a severity, an override, a narrowed plugin scope, `strict: false` through `extends`, a removed pattern, configuration file, support path or narrowed counter in the wiring, an added support path or configuration file over a file the base has, a base whose own configuration cannot run, an excluded directory, an ignored path, a group switched off, a lower preset, a package-extended configuration replaced, a reordered include list or override, two overrides of the same files swapped, whatever their key order) fails without a trailer and passes with the trailers its failure names, a plugin moved to another directory keeps its strictness, two plugins with one file name are refused, a wiring path outside the repository is refused, a compiler flag's trailer does not accept findings an unapproved exclusion lost, a trailer outside the last paragraph or without a reason is ignored, the `extends` resolution agrees with the compiler's own `--showConfig`, a package's `tsconfig` field and a file inside a package included, a missing base is skipped locally and fails in CI; parser tests on recorded outputs |
| `fixtures/` | A recorded Biome report and compiler output |

The gate needs git and the pinned Bun runtime, and imports the repository's
`lib/`; see [M1 mappings](../../mappings.md).
