---
name: docs
description: "Check a repository's documentation tree against its docs-governance rules in one pass (frontmatter schema, generated index, last_updated dates, review scars, deferrals), flag stale drafts and list the documents its project type still lacks; also holds those gates for hooks and CI. Use before a docs change or to plan a docs tree. Not for removing scars (use descar) or writing decision records (use adr)."
argument-hint: "[--json] [--base <ref>] [--type service|library|application]"
allowed-tools: "Read Write Edit Grep Glob Bash(bun *) Bash(git *)"
---

# Docs: one pass over a governed docs tree

A docs tree governed by Jig's docs-governance module
([M4](https://github.com/jig-harness/jig/blob/main/modules/M4-docs-governance/README.md))
holds every document to a frontmatter schema, keeps a generated index,
moves `last_updated` with the body, keeps approved pages free of review
[scars](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), and makes a
deferral name the tracker item that carries it. This skill runs each of those
gates over the tree, flags drafts nobody finished, and lists the documents the
project should have and does not. The gates themselves live in `scripts/`,
one folder each, so a repository's hooks and CI run the same code. The human's
page is [README.md](README.md).

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository whose docs you are
checking. Never `cd` into the skill directory.

## Not this skill

- **Removing scars** from a page: the pass reports them; `/jig:descar`
  removes them, with the judgment a lint cannot make.
- **Writing a decision record**: `/jig:adr`.
- **Promoting an agent's memory** into the docs tree: `/jig:promote-memory`.

## 1. Run the pass

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/docs.ts" --json
```

It detects everything it needs and reads the `docs` section of the
repository's Jig configuration only where detection is wrong:

- **The docs tree**: `docs.root`, else the first of `docs/`, `doc/`,
  `documentation/` that exists.
- **The schema**: `docs.schema`, else the shallowest
  `frontmatter-schema.yaml` (dotted or not, `.yaml` or `.yml`) under the docs
  tree. The repository's own schema is the one that applies: never check its
  documents against M4's template or rules of your own.
- **Stale drafts**: a `status: draft` document whose `last_updated` is more
  than `docs.stale_after_days` days old (180).
- **The base** for the `last_updated` check: `--base <ref>`, else
  `repository.base_branch`, else the remote's default branch.
- **The project type**: `service` (a deploy file such as a `Dockerfile`, a
  Compose file or a Helm chart), `library` (a published package), or
  `application` (any other build manifest), from the tracked files.
  `--type` overrides it; use it only after telling the user the detected
  type and its evidence, which the report gives.

The report (`schema: docs-report/v1`) lists each check's `status`: `ok`,
`findings`, `warnings`, `skipped` (with why) or `failed` (it could not
check). Then every finding with its file, check, severity and message, and
under `expected` each document the project type calls for, with `found` null
when it is missing. Without `--json` the same report is printed as text,
findings grouped by file.

Exit 0: no error. Exit 1: a check found an error. Exit 2: a check could not
run, or the configuration or command line is unusable; report the message and
stop. Stale drafts, orphaned documents and missing documents are warnings and
never fail the pass.

## 2. Act on it

Work in this order, and tell the user what you changed and what you left:

1. **A `failed` check**: report it; a pass with an unchecked gate is not a
   clean pass.
2. **Frontmatter errors**: fix each value against the schema. Take a "did you
   mean" hint when it fits; never add a value to the schema to make an error
   go away unless the user asks.
3. **Index drift**: regenerate, never edit by hand:
   `bun "${CLAUDE_SKILL_DIR}/scripts/index/generate-index.ts"` (it reads
   `DOCS_DIR`, default `docs`). Stage `INDEX.md` and `.orphans.md` together.
4. **`last_updated` not advanced**: set it to today's date in Coordinated
   Universal Time on each document whose body changed.
5. **Scars**: hand the pages to `/jig:descar`; do not rewrite them here.
6. **Deferrals that name no item**: name the tracker item that carries the
   work, or say what is true today. Never invent an item key.
7. **Stale drafts**: list them for the user with their owners; finishing,
   promoting or archiving one is the owner's call.
8. **Missing documents**: propose a plan, one line per document, with where it
   goes and the M4 template it starts from
   ([templates](https://github.com/jig-harness/jig/tree/main/modules/M4-docs-governance/templates)).
   Create documents only after the user agrees; with nobody there to answer,
   stop and state the plan.

Run the pass again after the fixes and report the checks that are still not
`ok`.

## The gates on their own

Each gate keeps its own command line, for a hook or a CI job; their
READMEs, beside each script, give the variables, modes and exit codes, and
M4's [mappings](https://github.com/jig-harness/jig/blob/main/modules/M4-docs-governance/mappings.md)
give the CI and hook wiring:

| Gate | Script |
|------|--------|
| Frontmatter valid | `scripts/frontmatter-check/frontmatter-check.ts` |
| Index and orphan report fresh | `scripts/index/generate-index.ts`, with `--check` |
| `last_updated` advanced | `scripts/stale-last-updated/stale-last-updated.ts` |
| Generator date stamping | `scripts/stamp/frontmatter-stamp.ts` (a library) |
| No scars in approved docs | `scripts/scar-lint/check-descarring-scars.ts` |
| A deferral names a live item | `scripts/deferral-references/check-deferrals.ts` |
