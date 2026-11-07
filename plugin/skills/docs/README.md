# `/jig:docs`: a docs tree checked in one pass

A documentation tree grows into hundreds of pages, and without checks nobody
can tell a current page from a stale one: frontmatter values drift, the index
falls behind the tree, dates stop moving with the text, approved pages keep
the traces of the review that produced them, and a "follow-up will be filed"
names nothing anyone can look up. Jig's docs-governance module
([M4](https://github.com/jig-harness/jig/blob/main/modules/M4-docs-governance/README.md))
states the rules; this skill is their runnable form. It holds M4's gates, each
a command a hook or a CI job runs, and a pass that runs them all over a
repository's docs tree, adds the warnings no gate gives (drafts nobody
finished) and lists the documents the project should have and lacks.

## The pass

```sh
bun "<skill-dir>/scripts/docs.ts"            # text, findings grouped by file
bun "<skill-dir>/scripts/docs.ts" --json     # the same report, schema docs-report/v1
```

Run it from the repository's root. It runs, in order:

| Check | What it reports | Applies when |
|-------|-----------------|--------------|
| `frontmatter` | each document whose frontmatter breaks the schema, with a "did you mean" hint; a document the branch adds is also held to the schema's `required_new` fields | the tree has a frontmatter schema |
| `index` | a committed `INDEX.md` or `.orphans.md` that no longer matches the tree, and the orphan count as a warning | the tree has a generated `INDEX.md` |
| `last_updated` | a document under the tree whose body the branch changed without advancing its date | a base branch resolves |
| `scars` | review scars in approved documents | always |
| `deferrals` | a deferral that names no tracker item, over every document | the repository has `.config/deferral-references.yaml` |
| `stale drafts` | a `status: draft` document not updated for longer than the threshold, as a warning | always |

Then it reads the project type from the tracked files (a deploy file makes a
service; a published package a library; any other build manifest an
application) and lists, under "Missing documentation", what M4's three layers
and its wiki schema expect and the tree lacks: the docs tree itself, an
instruction file, the wiki schema, the frontmatter schema, a generated index,
the activity log, decision records and a raw layer for every project;
architecture pages and runbooks for a service; a guide and a reference for a
library; architecture pages and a guide for an application. A document whose
frontmatter `type:` matches (a `type: runbook` page) counts as much as the
conventional folder.

Exit 0 means no error, 1 an error found, 2 a check that could not run (or an
unusable configuration), whatever the other checks found. Warnings and missing
documents never fail it.

## Configuration

Everything is detected; set a field in `.config/jig.yaml` only when detection
picks the wrong thing
([configuration reference](https://github.com/jig-harness/jig/blob/main/plugin/CONFIGURATION.md#procedure-skills)):

```yaml
docs:
  root: handbook                         # default: the first of docs/, doc/, documentation/
  schema: handbook/meta/schema.yaml      # default: the shallowest frontmatter-schema.yaml under the root
  stale_after_days: 90                   # default: 180, M4's six months
```

The `last_updated` check compares with `--base <ref>`, else
`repository.base_branch`, else the remote's default branch; a configured
`repository.base_branch` that does not resolve stops the pass rather than
falling back to another branch. `--type` overrides the detected project type.

## The gates

Each gate keeps the command line its README documents, so a repository that
runs one in a hook or CI calls it at its path in a pinned Jig checkout. M4's
[mappings](https://github.com/jig-harness/jig/blob/main/modules/M4-docs-governance/mappings.md)
give the wiring per CI provider and hook manager.

| Gate | README |
|------|--------|
| Frontmatter check, with its YAML subset and path-scoped rules | [scripts/frontmatter-check/](scripts/frontmatter-check/README.md) |
| Index generator, orphan report and freshness check | [scripts/index/](scripts/index/README.md) |
| Stale `last_updated` gate | [scripts/stale-last-updated/](scripts/stale-last-updated/README.md) |
| Sticky date stamping for generators | [scripts/stamp/](scripts/stamp/README.md) |
| De-scarring lint | [scripts/scar-lint/](scripts/scar-lint/README.md) |
| Deferral references, static and live | [scripts/deferral-references/](scripts/deferral-references/README.md) |

They share one frontmatter reader, `scripts/lib/docs.ts`, which reads a
stated subset of YAML and rejects everything outside it. The frontmatter
check reads the schema with the plugin's vendored js-yaml
(`shared/vendor/js-yaml.mjs`), so a copy of the gates keeps the plugin's
layout: the skill's folder two levels below the folder holding `shared/`.

## Works with

- [`descar`](../descar/SKILL.md) removes the scars this pass reports.
- [`promote-memory`](../promote-memory/SKILL.md) writes the pages the raw
  layer promotes.
- [`adr`](../adr/SKILL.md) keeps the decision records the plan expects.
