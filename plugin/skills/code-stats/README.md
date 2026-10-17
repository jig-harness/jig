# `/jig:code-stats`: what a repository is made of

How much of a repository is shipped product code, and how much is tests,
tooling, agent [scaffolding](https://github.com/docomply/jig/blob/main/GLOSSARY.md),
documentation, build or deployment files? In which languages, and in which
modules? Without a tool, each team answers with a one-off script that counts
everything as "code", so a repository with a large generated client, a
vendored library or a folder of test data looks bigger and less tested than
it is, and nobody can tell how much of it is the agents' instructions.

This skill answers with no setup. It classifies every file git tracks, counts
its bytes and its lines, and reports the totals in the terminal, as JSON for
other tools, or as one interactive HTML page. Where its detection is wrong
for a repository, a few values in `.config/jig.yaml` fix it, and
`--explain` shows which rule decided any file.

## What it measures

Every tracked file gets one value in each of the
[code-stats dimensions](https://github.com/docomply/jig/blob/main/GLOSSARY.md):

- **Area**: what the file is *for*. The first area rule that matches wins;
  a file no rule matches falls to the default area, `production`.
- **Kind**: what the file *is*: `code`, `test`, `docs`, `config`, `data`,
  `generated`, `fixture` (a [test fixture](https://github.com/docomply/jig/blob/main/GLOSSARY.md): data a test reads), `asset` (binary or media),
  `vendored` (another project's code kept in this one) or `other`.
- **Language**: from the file's extension; for a file without one, from its
  [shebang line](https://github.com/docomply/jig/blob/main/GLOSSARY.md)
  (`#!/usr/bin/env python3`); and a `linguist-language`
  [git attribute](https://github.com/docomply/jig/blob/main/GLOSSARY.md) in `.gitattributes` overrides both.
- **Module**: the deepest module folder that holds the file, from the
  repository's [workspace manifests](https://github.com/docomply/jig/blob/main/GLOSSARY.md) (below), or from `code_stats.modules`.

And its counts: bytes, all lines, blank lines, comment lines, and
[LOC (lines of code)](https://github.com/docomply/jig/blob/main/GLOSSARY.md): lines that are neither blank nor only a comment. Binary and media
files are sized but not line-counted; so is a text file over 20 MiB, which
is still classified from its first 8 KiB.

**Vendored files are left out of every total** by default, since they are
not the team's code; `--include-vendored` counts them, and every output says
how many were left out.

**The unclassified share.** A file is unclassified when its kind is `other`
or no area rule matched it. Every output shows the share of files and of LOC,
so a weak configuration is visible rather than silently counted as
production. With the default areas, product code is not matched by any rule
and counts as unclassified: give the repository's own folders an area in
`code_stats.areas` and the share drops to what really is unaccounted for.

## Commands

Run from the repository's root. `<skill-dir>` is this skill's folder in the
plugin.

```sh
bun <skill-dir>/scripts/code-stats.ts                    # terminal summary
bun <skill-dir>/scripts/code-stats.ts --json             # aggregates as JSON
bun <skill-dir>/scripts/code-stats.ts --html [out.html]  # interactive report
bun <skill-dir>/scripts/code-stats.ts --explain <path>   # why one file counts where it does
```

`--top N` sets the number of modules in the terminal summary (15), and
`--include-vendored` counts vendored files. The exit code is 0 on success, 1
when the report cannot be made, 2 for a command line the script cannot act
on.

### The terminal summary

The repository's name and date, the files counted, the vendored files left
out, the code and test LOC of the default area with their ratio, the
unclassified share, then tables by area, kind, language and module.

### The HTML report

One file that works offline, written to `.context/code-stats/code-stats.html`
unless a path is given. It holds every file's row and does its sums in the
browser:

- filters by area, kind, language, module and path (substring, or a regular
  expression written `/like this/`), each option showing its count;
- a measure switch: LOC, lines, files or size;
- headline tiles, the unclassified share among them;
- bar charts by area, language and module, split by kind, with tooltips;
  clicking a bar filters to it;
- a pivot of any dimension against any other, exported as CSV or copied as
  TSV;
- a directory explorer that expands folder by folder, exported as CSV;
- the largest files;
- light and dark themes from a colour-blind-checked palette;
- the current view kept in the address, so a filtered view can be bookmarked.

It lists every file path, so treat it like the repository itself before
sharing it.

### The JSON report

```json
{
  "schema": "code-stats/v1",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "repository": "shop",
  "commit": "abc1234",
  "branch": "main",
  "totals": { "files": 0, "bytes": 0, "rawLines": 0, "codeLines": 0, "commentLines": 0, "blankLines": 0 },
  "unclassified": { "files": 0, "codeLines": 0, "filesShare": 0, "codeShare": 0, "kindOther": 0, "defaultArea": 0 },
  "vendored": { "included": false, "excludedFiles": 0, "excludedBytes": 0 },
  "missingFromWorkingTree": 0,
  "areas": [{ "name": "docs", "description": "…", "default": false }],
  "byArea": { "docs": { "files": 0, "bytes": 0, "raw": 0, "code": 0, "comment": 0, "blank": 0 } },
  "byKind": {},
  "byLanguage": {},
  "byModule": {},
  "byAreaKind": { "docs/docs": {} }
}
```

- `schema` names the shape. A change that renames or removes a field, or
  changes what one means, is a new version; adding a field is not.
- `commit` ends in `-dirty` when tracked files differ from it: the counts
  are the working tree's.
- Shares are fractions from 0 to 1. `unclassified.files` counts each file
  once; `kindOther` and `defaultArea` count each reason, and a file can
  have both.
- `missingFromWorkingTree` counts tracked files deleted in the working tree,
  which are not counted.
- Every `by…` value is a bucket: `files`, `bytes`, `raw` (all lines),
  `code` (LOC), `comment`, `blank`. `byArea` lists the areas in their rule
  order, `byKind` in the order of the kinds above, the others by name.

### `--explain`

```text
crates/core/build.rs
  area:     build — default area rule "build", build tool: Cargo (glob "**/build.rs")
  kind:     code — build tool: Cargo (glob "**/build.rs"), code
  language: Rust — extension .rs
  module:   crates/core — Cargo workspace members "crates/*"
  counts:   1.2 KB; 40 lines: 31 code, 5 comment, 4 blank
```

Every dimension names the rule that set it: a convention, an attribute, a
banner, an extension or shebang, a `code_stats` field with its position, a
manifest, a fallback, or `classify_command`. `--json` prints the same as an
object.

## How a file is classified

The layers, lowest precedence first; a later layer overrides an earlier one.

1. **Built-in detection**, which needs no configuration (the rest of this
   section).
2. **Test-runner configuration**: not read yet (planned: the test patterns
   jest, vitest, pytest and Gradle declare).
3. **The `code_stats` configuration**: the areas, the default area, and kind
   globs checked before built-in detection.
4. **The [classify command](https://github.com/docomply/jig/blob/main/GLOSSARY.md)**, when the repository supplies one.

### Kinds

In order, the first that applies:

1. A submodule is `vendored`; a symbolic link is `other`, sized by the link,
   never followed.
2. The attributes in `.gitattributes`, read with one `git check-attr` call:
   `linguist-vendored` makes a file `vendored`, `linguist-generated`
   `generated`, `linguist-documentation` `docs`. An unset attribute
   (`-linguist-vendored`, `-linguist-generated`) turns off the matching
   conventions below for that file.
3. The vendored conventions.
4. A media extension, or a zero byte in the first 8 kilobytes, makes a file `asset`.
5. The generated conventions, then a generator banner in the file's leading
   comment: `@generated`, `DO NOT EDIT`, or Go's `Code generated … DO NOT
   EDIT.`. Only the comment that opens the file counts, so prose that merely
   mentions generation ("auto-generated IDs", "# Generated files") does not.
   Nor does a comment that discusses the markers: one quoted in backticks or
   double quotes is not counted, and `@generated` counts only as a tag that
   opens a comment line or in "is/was @generated".
6. The fixture conventions.
7. The test conventions. A file one matches is `test` when it is code; a
   file in a test folder that is not code is a `fixture`, or `docs`, never
   test LOC. The fixture and test conventions decide a build file's kind
   too: a `vite.config.ts` in a fixture folder is a fixture, though its
   area is still `build`.
8. A build tool's file (the build tool table below) outside test and
   fixture folders is `config`, or `code` when it is code: a `build.gradle`
   is configuration, not `other`.
9. The extension: code, documentation, data or configuration. YAML, JSON and
   other configuration files in an area with `content: true` are `data`. A
   file without an extension whose shebang names a programming language is
   `code`. Anything else is `other`.

The conventions:

| Kind | Ecosystem | Rule |
|------|-----------|------|
| vendored | Any | vendor/ folder |
| vendored | Any | third\_party/ or third-party/ folder |
| vendored | JavaScript | node\_modules/ folder |
| generated | Any | generated/ or \_generated/ folder |
| generated | Any | .gen/ folder, \*.generated.\* or \*.gen.\* |
| generated | Protocol Buffers | \*.pb.\*, \*\_pb.\*, \*\_pb2.py or \*\_connect.\* output |
| generated | Drizzle | drizzle/meta/ snapshots |
| generated | TypeScript | \*.d.ts under a dist/ folder |
| generated | JavaScript | lockfile (bun.lock, bun.lockb, package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock, deno.lock) |
| generated | Python | lockfile (poetry.lock, uv.lock, Pipfile.lock, pdm.lock) |
| generated | Go | lockfile (go.sum) |
| generated | Rust | lockfile (Cargo.lock) |
| generated | Ruby | lockfile (Gemfile.lock) |
| generated | PHP | lockfile (composer.lock) |
| generated | Java/Kotlin | lockfile (gradle.lockfile) |
| generated | .NET | lockfile (packages.lock.json) |
| generated | Elixir | lockfile (mix.lock) |
| generated | Swift | lockfile (Package.resolved) |
| generated | Dart | lockfile (pubspec.lock) |
| generated | Nix | lockfile (flake.lock) |
| fixture | Go | testdata/ folder |
| fixture | Any | \_\_fixtures\_\_/, fixtures/ or test-fixtures/ folder |
| fixture | JavaScript/TypeScript | \_\_snapshots\_\_/ or snapshots/ folder, or \*.snap |
| fixture | Any | mocks/ or \_\_mocks\_\_/ folder |
| test | JavaScript/TypeScript | \*.test.\* or \*.spec.\* |
| test | JavaScript/TypeScript | \_\_tests\_\_/ folder |
| test | Python | test\_\*.py or \*\_test.py |
| test | Python | conftest.py |
| test | Go | \*\_test.go |
| test | Java/Kotlin | src/test/ or src/integrationTest/ folder |
| test | Rust | benches/ folder |
| test | Ruby | spec/ folder or \*\_spec.rb |
| test | PHP | \*Test.php |
| test | C# | \*.Tests/ folder |
| test | Elixir | \*\_test.exs |
| test | Shell | \*.bats |
| test | Python, Rust, JavaScript/TypeScript and others | tests/ or test/ folder |


### Default areas

When `code_stats.areas` is absent. The first match wins, so the specific
rules come first: agent files in `.github/` are scaffolding before `ci` takes
the workflows; a Makefile under `tools/` is `build`, and
`tools/db/migrations/` is `database`, before `tools` takes the folder;
`repo-config` takes the `.github/` files no earlier area claims. Everything
else falls to `production`.

| Area | What it holds | Paths |
|------|---------------|-------|
| `scaffolding` | AI agent scaffolding: agent instructions, skills, rules and agent tool settings | `.claude/**`, `.cursor/**`, `.codex/**`, `.windsurf/**`, `.agents/**`, `.gemini/**`, `.roo/**`, `.continue/**`, `.aider*`, `.cursorrules`, `.windsurfrules`, `.clinerules*`, `.mcp.json`, `**/AGENTS.md`, `**/CLAUDE.md`, `**/GEMINI.md`, `.github/copilot-instructions.md`, `.github/instructions/**`, `.github/prompts/**`, `.github/chatmodes/**`, `.github/agents/**` |
| `ci` | CI pipelines: workflow and pipeline definitions | `.github/workflows/**`, `.github/actions/**`, `.gitlab-ci.yml`, `.gitlab/ci/**`, `.circleci/**`, `.buildkite/**`, `**/Jenkinsfile*`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.travis.yml`, `.woodpecker*`, `.woodpecker/**` |
| `build` | Build definitions and build tooling: the files of a dedicated build tool (see the build tool table) | every build tool below |
| `database` | Database schema and migrations, by the tool or convention that writes them (see the database table) | every database convention below, never a path under `.github/` |
| `ops` | Deployment and infrastructure: Terraform, Helm, Kubernetes, Ansible, containers and compose files | `deploy*/**`, `infra/**`, `infrastructure/**`, `terraform/**`, `**/*.tf`, `**/*.tfvars`, `charts/**`, `helm/**`, `**/Chart.yaml`, `k8s/**`, `kubernetes/**`, `**/kustomization.y*ml`, `ansible/**`, `**/Dockerfile*`, `**/*.dockerfile`, `**/Containerfile*`, `**/.dockerignore`, `**/docker-compose*.y*ml`, `**/compose.y*ml`, `**/compose.*.y*ml` |
| `tools` | Internal developer tooling that does not ship: tools/, scripts/, bin/, hack/ | `tools/**`, `scripts/**`, `script/**`, `bin/**`, `hack/**` |
| `docs` | Documentation: docs/, doc/, root-level documents and licence files | `docs/**`, `doc/**`, `*.md`, `*.rst`, `*.adoc`, `LICENSE*`, `LICENCE*`, `COPYING*` |
| `repo-config` | Repository configuration: root-level files that are not code (manifests, lockfiles, linter and editor settings) and the .github/ files no other area takes (CODEOWNERS, issue templates, dependency-update settings) | `.github/**`; a root-level file that is not code |

### Build tools

The `build` area takes the files of a dedicated build tool. A package
manager's manifest that is not a build tool's (`package.json`,
`pyproject.toml`, `go.mod`, `Gemfile`, `composer.json`, `requirements*.txt`)
is not build: a root-level one is `repo-config`. Test configuration, such as
`vitest.config.*`, is not build either.

| Tool | Ecosystem | Paths |
|------|-----------|-------|
| Gradle | JVM | `**/build.gradle`, `**/build.gradle.kts`, `**/settings.gradle`, `**/settings.gradle.kts`, `**/gradle.properties`, `gradle/**`, `**/gradlew`, `**/gradlew.bat`, `buildSrc/**` |
| Maven | JVM | `**/pom.xml`, `.mvn/**`, `**/mvnw`, `**/mvnw.cmd` |
| sbt | JVM | `**/build.sbt`, `project/*.sbt`, `project/build.properties` |
| Ant | JVM | `**/build.xml` |
| Mill | JVM | `**/build.sc`, `**/build.mill` |
| Cargo | Rust | `**/Cargo.toml`, `**/build.rs`, `**/.cargo/**`, `**/rust-toolchain`, `**/rust-toolchain.toml`, `**/Cross.toml` |
| GoReleaser | Go | `**/.goreleaser.yml`, `**/.goreleaser.yaml` |
| Mage | Go | `**/magefile.go`, `magefiles/**` |
| Vite | JavaScript/TypeScript | `**/vite.config.*` |
| webpack | JavaScript/TypeScript | `**/webpack.config.*`, `**/webpack.*.js` |
| Rollup | JavaScript/TypeScript | `**/rollup.config.*` |
| esbuild | JavaScript/TypeScript | `**/esbuild.config.*` |
| Parcel | JavaScript/TypeScript | `**/.parcelrc` |
| Rspack/Rsbuild | JavaScript/TypeScript | `**/rspack.config.*`, `**/rsbuild.config.*` |
| tsup | JavaScript/TypeScript | `**/tsup.config.*` |
| SWC | JavaScript/TypeScript | `**/.swcrc` |
| Babel | JavaScript/TypeScript | `**/babel.config.*`, `**/.babelrc`, `**/.babelrc.*` |
| TypeScript compiler | JavaScript/TypeScript | `**/tsconfig.json`, `**/tsconfig.*.json`, `**/tsconfig-*.json` |
| Turborepo | JavaScript/TypeScript | `**/turbo.json` |
| Nx | JavaScript/TypeScript | `nx.json` |
| Lerna | JavaScript/TypeScript | `lerna.json` |
| Gulp | JavaScript/TypeScript | `**/gulpfile.*` |
| Grunt | JavaScript/TypeScript | `**/Gruntfile.*` |
| setuptools | Python | `**/setup.py`, `**/setup.cfg`, `**/MANIFEST.in` |
| Hatch | Python | `**/hatch.toml` |
| nox | Python | `**/noxfile.py` |
| tox | Python | `**/tox.ini` |
| MSBuild | .NET | `**/*.csproj`, `**/*.fsproj`, `**/*.vbproj`, `**/*.sln`, `**/Directory.Build.props`, `**/Directory.Build.targets`, `**/Directory.Packages.props`, `global.json`, `**/nuget.config`, `**/NuGet.Config` |
| Cake | .NET | `**/build.cake` |
| Make | C/C++ and others | `**/Makefile`, `**/GNUmakefile`, `**/makefile`, `**/*.mk` |
| CMake | C/C++ | `**/CMakeLists.txt`, `**/*.cmake`, `**/CMakePresets.json` |
| Meson | C/C++ | `**/meson.build`, `**/meson_options.txt` |
| Ninja | C/C++ | `**/build.ninja` |
| Autotools | C/C++ | `**/configure.ac`, `**/Makefile.am`, `**/Makefile.in` |
| Conan | C/C++ | `**/conanfile.py`, `**/conanfile.txt` |
| vcpkg | C/C++ | `**/vcpkg.json` |
| Bazel or Pants | Monorepo and polyglot | `**/BUILD`, `**/BUILD.bazel` |
| Bazel | Monorepo and polyglot | `WORKSPACE`, `WORKSPACE.bazel`, `WORKSPACE.bzlmod`, `MODULE.bazel`, `**/*.bzl`, `.bazelrc`, `.bazelversion` |
| Buck2 | Monorepo and polyglot | `**/BUCK`, `.buckconfig` |
| Pants | Monorepo and polyglot | `pants.toml` |
| Earthly | Monorepo and polyglot | `**/Earthfile` |
| Nix | Monorepo and polyglot | `**/flake.nix`, `**/default.nix`, `**/shell.nix` |
| just | Task runners | `**/justfile`, `**/Justfile`, `**/.justfile` |
| Task | Task runners | `**/Taskfile.yml`, `**/Taskfile.yaml` |
| Rake | Task runners | `**/Rakefile` |
| Swift Package Manager | Swift | `**/Package.swift` |
| Mix | Elixir | `**/mix.exs` |
| Cabal or Stack | Haskell | `**/*.cabal`, `**/stack.yaml` |
| build_runner | Dart/Flutter | `**/build.yaml` |

### Database

The `database` area takes schema definitions
([DDL, data definition language](https://github.com/docomply/jig/blob/main/GLOSSARY.md))
and migrations, by the tool or convention that writes them. The specific
tools come first, so `--explain` names the most specific one. A plain `.sql`
file is not schema by itself (it may be a query), so no rule takes every
`.sql` file; and a migration's kind is still what the kind rules say (a SQL
or Python migration is `code`). The generic `migrations/` rule can catch a
migration that is not a database's, such as a configuration migrator: give
it its own area in `code_stats.areas`.

| Tool or convention | Ecosystem | Paths |
|--------------------|-----------|-------|
| Rails | Ruby | `db/migrate/**`, `db/schema.rb`, `db/structure.sql`, `db/seeds.rb` |
| Laravel | PHP | `database/migrations/**`, `database/seeders/**`, `database/factories/**` |
| Ecto | Elixir | `priv/repo/migrations/**` |
| Entity Framework Core | .NET | `**/Migrations/*.cs` |
| Django | Python | `**/migrations/*.py` |
| Alembic | Python | `**/alembic.ini`, `**/alembic/**` |
| Prisma | JavaScript/TypeScript | `**/schema.prisma`, `**/prisma/migrations/**` |
| Drizzle | JavaScript/TypeScript | `**/drizzle.config.*`, `**/drizzle/**` |
| Knex | JavaScript/TypeScript | `**/knexfile.*` |
| Sequelize | JavaScript/TypeScript | `**/.sequelizerc` |
| Supabase | Postgres | `supabase/migrations/**` |
| Hasura | GraphQL | `hasura/migrations/**`, `hasura/metadata/**` |
| Flyway | JVM and others | `**/db/migration/**`, `**/flyway.conf`, `**/flyway.toml` |
| Liquibase | JVM and others | `**/db/changelog/**`, `**/liquibase.properties` |
| Atlas | Any | `**/atlas.hcl` |
| Sqitch | Any | `**/sqitch.plan`, `**/sqitch.conf` |
| golang-migrate or dbmate | Any | `**/*.up.sql`, `**/*.down.sql` |
| generic migrations folder | Any | `**/migrations/**`, `**/migration/**`, `**/db/migrate/**` |
| generic schema file | Any | `**/*.ddl`, `**/schema.sql`, `**/structure.sql` |
| generic seed folder | Any | `**/db/seeds/**`, `**/db/seeders/**`, `**/database/seeds/**`, `**/database/seeders/**` |

### Modules

From the workspace manifests at the root: `pnpm-workspace.yaml` (`packages`,
with `!` exclusions), `package.json` `workspaces` (a list or `{packages}`),
`go.work` (`use`), Cargo's `[workspace] members` and `exclude` (and a root
package), Gradle's `settings.gradle` or `settings.gradle.kts` (`include`,
`:a:b` meaning `a/b`) and uv's `[tool.uv.workspace] members` and `exclude`
in `pyproject.toml`. A member glob matches tracked folders; for pnpm, npm,
Cargo and uv the folder must hold that tool's manifest. A file belongs to
the deepest member folder that holds it. Without a manifest, or for a file
outside every member, the module is the first two folders under a common
container folder (`apps`, `packages`, `services`, `libs`, `crates`, `cmd`,
`internal`, `modules`, `plugins`, `tools`, `projects`, `components`,
`examples`, `extensions`), else the first folder, and `<root>` for a file at
the root.

### Lines

Comment lines are recognised per language: `//` and `/* … */` (C, Java,
Kotlin, C#, C++, Swift, PHP, Go, Rust, JavaScript, TypeScript, CSS), `#`
(Python, shell, Ruby, Elixir, R, Perl, PowerShell, YAML, TOML, Terraform,
Dockerfiles), `--` and `/* … */` (SQL) and `<!-- … -->` (HTML, XML,
Markdown, Vue, Svelte, Astro). Code after a closing `*/` on the same line
makes the line code, and a block comment opened after code continues onto
the lines below. Block comments nest in Rust, Kotlin, Swift, Scala and
Dart, as those languages nest them. Comment markers inside a string are
code: a `"…"` or `'…'` string ends on its line, a `` `…` `` or `"""…"""`
string runs across lines, as do Python's `'''…'''` and SQL's quoted
strings; markup takes no strings. A backslash escapes a quote, except in
SQL, which doubles it (`'it''s'`) outside an escape string (`E'it\'s'`);
an escape string stays one across a doubled quote and into a fragment
continued on the next line, after whitespace and `--` comments.
In JavaScript and TypeScript a
regular-expression literal (`/[/*]/`) is code too, recognised where an
expression may start: after an operator, an opening bracket or a keyword
such as `return`, never after a closing bracket or a name. The counter
reads each language's lexical rules as one table and does not parse, so
rarer forms count as their markers suggest: Rust raw strings, shell strings
across lines, heredocs, a division right after `++` or `--` (read as a
regular expression), and a regular expression right after `if (…)` or
`while (…)` (read as a division). A file without an extension takes the comment syntax of
the language its shebang names, and an extension without one takes that of
the language a `linguist-language` attribute or the classify command names.
Other files count every non-blank line as code.

## Configuration

All optional, in the repository's `.config/jig.yaml`; every field is in the
[configuration reference](../../CONFIGURATION.md#code_stats).

```yaml
code_stats:
  areas:                  # ordered, first match wins; replaces the default list
    - name: scaffolding
      description: Agent instructions and skills
      paths: [".claude/**", "**/AGENTS.md", "**/CLAUDE.md"]
    - name: content
      description: Structured content the product loads
      paths: ["content/**"]
      content: true       # YAML and JSON here count as data, not configuration
    - name: product
      paths: ["apps/**", "packages/**"]
  default_area: production
  kinds:                  # checked before built-in detection, in this order
    fixture: ["acceptance/fixtures/**"]
    test: ["scripts/smoke-*.sh"]
    generated: ["docs/catalogue.md"]
  modules: ["apps/*", "packages/*"]   # default: from the workspace manifests
  classify_command: null
```

A repository that sets `areas` writes its whole list: copy the default areas
it wants to keep.

### The classify command

When globs cannot say it, `code_stats.classify_command` names a command of
the repository's own. It runs once, from the repository root, with every
tracked path on standard input, one per line. It prints one JSON object per
line, `{"path": "…", "area": "…", "kind": "…", "language": "…", "module":
"…"}`, with any of the values left out; the values it gives override
every other layer. It must exit 0 within 300 seconds
(`JIG_CODE_STATS_COMMAND_TIMEOUT_SEC` changes that). A non-zero exit, a line
that is not such an object, a path that is not tracked, an area the report
does not know (one of `code_stats.areas`, or the default area) or an unknown
kind is an error naming the problem, and no report is made. Because paths
reach the command one per line, a repository with a tracked path that holds
a newline cannot use a command: the report refuses to start rather than
classify that file wrongly.

## Fails closed

A failed `git ls-files` or `git check-attr`, or a failed classify command, is
an error, never an empty report. A configuration value the skill cannot use
(an unknown kind, a malformed glob, a duplicate area name, a value of the
wrong type) is refused with a message naming the field and the file that set
it. A report template without exactly one data placeholder is refused.

## Known limit

Tests written inside production files (Rust `#[cfg(test)]` modules, Python
and Elixir doctests) count as production code. Splitting them out would mean
parsing each language.
