---
release: minor
---

### Added

- [`/jig:code-stats`](../plugin/skills/code-stats/README.md) measures what a
  repository is made of. It classifies every tracked file by area (what it is
  for: scaffolding, CI, build, database, ops, tools, docs, repository
  configuration, production), kind (code, test, docs, config, data,
  generated, fixture, asset, vendored), language and module, counts its lines
  of code, and reports in the terminal, as versioned JSON (`--json`) or as a
  self-contained interactive HTML report (`--html`). It needs no setup: test
  conventions for JavaScript and TypeScript, Python, Go, Java and Kotlin,
  Rust, Ruby, PHP, C#, Elixir and shell, the `linguist-*` attributes in
  `.gitattributes`, generator banners, lockfiles, a table of build tools and
  one of database tools, and the workspace manifests of pnpm, npm, Go, Cargo,
  Gradle and uv. Vendored files are left out of the totals unless
  `--include-vendored` is given. Every output shows the unclassified share,
  so a layout the defaults do not fit is visible, and `--explain <path>`
  names the rule behind each value of one file. A new
  [`code_stats`](../plugin/CONFIGURATION.md#code_stats) section of
  `.config/jig.yaml` sets the areas, the default area, kind globs and module
  folders, and `code_stats.classify_command` lets a repository classify files
  with a command of its own.
