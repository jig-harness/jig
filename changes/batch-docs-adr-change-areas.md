---
release: minor
---

Fixes and additions to the `docs`, `adr`, `change-areas` and `jig` skills.

### Added

- `docs`: `docs.index` shapes the generated `INDEX.md`: a `preamble` file kept
  verbatim above the listing, a `descriptions` line per category (or each
  folder's `README.md` description, with `descriptions_from_readme`), an
  `order` (`name`, `count`, or categories listed first) and `frontmatter`,
  with `last_updated` stamped. An index with frontmatter is held to the
  schema like any page. With none of these set, the output is unchanged.
- `adr`: `validate-rules.ts` takes `--interpreter=yaml`, or reads a top-level
  `interpreter: yaml` field in the catalog, for a catalog enforced by an
  interpreter that parses YAML. The comparison with the reference
  interpreter's line reading is then not made, so double-quote escapes and a
  block-list `exclude` pass, and the checks that hold for either reader stay.
  A rule with an `implementation`, `detector` or `pattern_<name>` field is no
  longer reported for lacking `pattern`.
- `change-areas`: `runCheck` takes `invariants`, keyed by the generic
  invariants' names (`graph`, `output-names`, `workspace`, `generated`), to
  exempt one or replace it with the composer's own check; `checkCatalog`
  takes the same map. An unknown name is refused.

### Fixed

- `jig`: the manual copy layout in the plugin README now lists the
  plugin-root files the skill reads, and the skill says where to read them
  when they are missing.
- `docs`: the reader no longer assigns a loop index inside the loop or uses
  two regular expressions with super-linear backtracking (SonarCloud's notes
  on the docs reader); what it reads is unchanged.
